/**
 * The deployment posture, enforced.
 *
 * The cluster is the bank's Red Hat OpenShift, which applies the
 * `restricted-v2` security context constraint. Most of what follows is not
 * generic Kubernetes hygiene — it is the specific set of things that either
 * stop a pod starting under that constraint, or quietly weaken it.
 *
 * The one that catches people is the UID. OpenShift assigns an arbitrary,
 * per-namespace UID at runtime; an image or manifest that pins one is the
 * usual reason a container that ran fine locally will not start on the
 * cluster.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string): string => readFileSync(`${ROOT}${p}`, 'utf8');

interface Manifest {
  kind: string;
  spec?: Record<string, any>;
}

const manifests = parseAllDocuments(read('deploy/openshift/origination.yaml'))
  .map((d) => d.toJS() as Manifest | null)
  .filter((d): d is Manifest => d !== null && typeof d.kind === 'string');

const deployment = manifests.find((m) => m.kind === 'Deployment');
const container = deployment?.spec?.['template'].spec.containers[0];
const podSecurity = deployment?.spec?.['template'].spec.securityContext;

const containerfile = read('/services/origination/Containerfile');

describe('OpenShift restricted-v2 compatibility', () => {
  it('pins no UID in the manifest', () => {
    // OpenShift assigns one per namespace. Pinning is the usual reason a pod
    // will not start.
    expect(podSecurity?.runAsUser).toBeUndefined();
    expect(container.securityContext?.runAsUser).toBeUndefined();
  });

  it('refuses to run as root', () => {
    expect(podSecurity?.runAsNonRoot).toBe(true);
  });

  it('drops every capability and forbids privilege escalation', () => {
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(['ALL']);
  });

  it('runs on a read-only root filesystem with a bounded writable mount', () => {
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    const tmp = deployment?.spec?.['template'].spec.volumes.find(
      (v: { name: string }) => v.name === 'tmp',
    );
    expect(tmp.emptyDir.sizeLimit).toBeTruthy();
  });

  it('binds an unprivileged port', () => {
    // The container holds no capability to bind below 1024.
    expect(container.ports[0].containerPort).toBeGreaterThan(1024);
  });

  it('grants group 0 access in the image, because the runtime UID is in it', () => {
    expect(containerfile).toMatch(/chgrp -R 0/);
    expect(containerfile).toMatch(/chmod -R g=u/);
  });

  it('declares a non-root USER so the image fails closed elsewhere', () => {
    const user = /^USER\s+(\S+)/m.exec(containerfile);
    expect(user).not.toBeNull();
    expect(user?.[1]).not.toBe('root');
    expect(user?.[1]).not.toBe('0');
  });
});

describe('the deployment does not lose requests', () => {
  it('keeps full capacity through a rollout', () => {
    // A state-changing API should not shed capacity to a routine deploy.
    expect(deployment?.spec?.['strategy'].rollingUpdate.maxUnavailable).toBe(0);
  });

  it('allows longer to terminate than it takes to drain', () => {
    const grace = deployment?.spec?.['template'].spec.terminationGracePeriodSeconds as number;
    const drain = Number(
      container.env.find((e: { name: string }) => e.name === 'DRAIN_MS').value,
    );
    expect(grace * 1000).toBeGreaterThan(drain);
  });

  it('separates liveness from readiness', () => {
    // Conflating them means a draining pod is restarted instead of drained.
    expect(container.livenessProbe.httpGet.path).toBe('/healthz');
    expect(container.readinessProbe.httpGet.path).toBe('/readyz');
  });

  it('keeps one replica available during voluntary disruption', () => {
    const pdb = manifests.find((m) => m.kind === 'PodDisruptionBudget');
    expect(pdb?.spec?.['minAvailable']).toBe(1);
  });
});

describe('the service is not reachable except through the gateway', () => {
  it('publishes no Route', () => {
    // A Route would be a second, ungoverned path to a state-changing API,
    // bypassing every gateway policy.
    expect(manifests.map((m) => m.kind)).not.toContain('Route');
  });

  it('restricts ingress to the gateway namespace', () => {
    const policy = manifests.find((m) => m.kind === 'NetworkPolicy');
    expect(policy).toBeDefined();
    expect(policy?.spec?.['policyTypes']).toContain('Ingress');
    expect(policy?.spec?.['ingress'][0].from[0].namespaceSelector).toBeTruthy();
  });
});

describe('no secret is in the manifest', () => {
  it('references credentials rather than inlining them', () => {
    const raw = read('/deploy/openshift/origination.yaml');
    expect(raw).toMatch(/secretKeyRef/);
    // A literal long opaque value assigned to a token-shaped env var.
    expect(raw).not.toMatch(
      /(token|secret|password|api[_-]?key)\w*:\s*['"]?[A-Za-z0-9_\-+/=]{16,}/i,
    );
  });

  it('declares no Secret object, so none can be committed here', () => {
    expect(manifests.map((m) => m.kind)).not.toContain('Secret');
  });
});
