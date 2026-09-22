/**
 * Health.
 *
 * Three endpoints, because they answer three different questions and a single
 * endpoint that answers all three causes outages.
 *
 * **`/healthz` — liveness. Is this process wedged?**
 * Checks nothing downstream. Ever. This is the rule most often broken and the
 * consequences are severe: if liveness fails when the database is unreachable,
 * the platform restarts every pod, repeatedly, while the database is still
 * unreachable. A restart loop across the whole deployment turns a recoverable
 * dependency outage into an unrecoverable one, and it does so at exactly the
 * moment the on-call engineer needs the pods to stay up and keep logging.
 *
 * **`/readyz` — readiness. Should this pod receive traffic?**
 * Checks what is *pod-local* — are we draining, did startup finish. It does
 * not check shared dependencies either, for a related reason: if every pod
 * depends on the same database, a shared outage marks all of them unready, the
 * service loses every endpoint, and callers get a connection failure instead
 * of a `503` with a problem detail explaining what is wrong.
 *
 * **`/health` — the real one. Is everything actually working?**
 * Runs the dependency checks and reports each component. **Authenticated**,
 * because the answer names the systems we depend on, their status and their
 * latency — a map of the estate and where it is weak. That is reconnaissance,
 * and it is exactly what the two probe endpoints deliberately withhold.
 *
 * The rule in one line: the endpoints that orchestrate say nothing, and the
 * endpoint that says something does not orchestrate.
 */

export type ComponentStatus = 'UP' | 'DEGRADED' | 'DOWN';

export interface CheckResult {
  readonly status: ComponentStatus;
  /** Safe to show an authenticated operator. Never a credential or a host. */
  readonly detail?: string;
}

export interface HealthCheck {
  readonly name: string;
  /**
   * Whether the service can do its job without this.
   *
   * A critical component being down makes the service `DOWN`. A
   * non-critical one makes it `DEGRADED` — which still answers `200`,
   * because a monitoring system that pages on every degraded dependency
   * trains people to ignore it.
   */
  readonly critical: boolean;
  run(): Promise<CheckResult>;
}

export interface ComponentReport {
  readonly name: string;
  readonly status: ComponentStatus;
  readonly detail?: string;
  /** Milliseconds. Useful for spotting a dependency that is slow, not dead. */
  readonly tookMs: number;
}

export interface HealthReport {
  readonly status: ComponentStatus;
  readonly checkedAt: string;
  readonly components: readonly ComponentReport[];
}

/** A check that hangs is a check that takes the health endpoint down with it. */
const CHECK_TIMEOUT_MS = 2_000;

async function runOne(check: HealthCheck, nowMs: () => number): Promise<ComponentReport> {
  const started = nowMs();

  const timeout = new Promise<CheckResult>((resolve) => {
    setTimeout(
      () => { resolve({ status: 'DOWN', detail: 'check timed out' }); },
      CHECK_TIMEOUT_MS,
    ).unref?.();
  });

  let result: CheckResult;
  try {
    result = await Promise.race([check.run(), timeout]);
  } catch {
    // The thrown value is deliberately not read. An exception from a client
    // library routinely carries a connection string, and a connection string
    // routinely carries a password (§4).
    result = { status: 'DOWN', detail: 'check threw' };
  }

  return {
    name: check.name,
    status: result.status,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    tookMs: nowMs() - started,
  };
}

/**
 * Aggregate to a single status.
 *
 * Any critical component down makes the whole service down. A non-critical
 * failure, or any degradation, is degraded. Everything else is up.
 */
export function aggregate(
  components: readonly ComponentReport[],
  criticalByName: ReadonlyMap<string, boolean>,
): ComponentStatus {
  let degraded = false;

  for (const component of components) {
    const critical = criticalByName.get(component.name) ?? true;
    if (component.status === 'DOWN') {
      if (critical) return 'DOWN';
      degraded = true;
    }
    if (component.status === 'DEGRADED') degraded = true;
  }

  return degraded ? 'DEGRADED' : 'UP';
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

export function createHealthService(params: {
  readonly checks: readonly HealthCheck[];
  readonly nowMs?: () => number;
  readonly nowIso?: () => string;
}): HealthService {
  const nowMs = params.nowMs ?? ((): number => Date.now());
  const nowIso = params.nowIso ?? ((): string => new Date().toISOString());
  const criticalByName = new Map(params.checks.map((c) => [c.name, c.critical]));

  return {
    async check(): Promise<HealthReport> {
      // Concurrently: N sequential checks means the endpoint's latency is the
      // sum of every dependency's worst case.
      const components = await Promise.all(params.checks.map((c) => runOne(c, nowMs)));
      return {
        status: aggregate(components, criticalByName),
        checkedAt: nowIso(),
        components,
      };
    },
  };
}

/** The HTTP status a report maps to. */
export function statusCodeFor(status: ComponentStatus): number {
  // DEGRADED is a 200 on purpose. The service is serving; something
  // non-critical is unhappy. Returning 503 here would take the service out of
  // rotation for a problem it can work around.
  return status === 'DOWN' ? 503 : 200;
}
