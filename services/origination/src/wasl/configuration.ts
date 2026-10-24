/**
 * The Wasl configuration in force (W5b): what every Wasl step, screen and
 * check reads, so a change approved in Admin binds from its effective moment
 * and nothing reads around it.
 *
 *   - Programmes and their anchors: the approved PROGRAMMES revision effective
 *     then, else the checked-in file. Distributors and the institution stay in
 *     the file (onboarding).
 *   - The board's positions, its goods register among them: the approved
 *     BOARD_POSITIONS revision effective then, else the file (SR-025).
 *
 * The check a programme change must pass is in programme-changes.ts.
 */
import {
  type TenantCode,
  type WaslParties,
  type WaslProgramme,
  loadBoardPositions,
  loadWaslParties,
  parseWaslProgrammes,
} from '@sanad/config/loader.ts';
import { type Result, ok } from '@sanad/core/kernel/result.ts';
import { type BoardPositions, parseBoardPositions } from '@sanad/products/murabaha-scf/structures/board-positions.ts';

import { tenantUuidByCode } from '../credentials.ts';
import { hostClockInstant } from '../host-clock.ts';
import { waslPool } from './book.ts';

export interface Resolved<T> {
  readonly value: Result<T>;
  readonly source: 'REVISION' | 'FILE';
  readonly revisionSummary?: string;
}

async function effective(
  tenant: TenantCode,
  area: 'PROGRAMMES' | 'BOARD_POSITIONS',
  asOf: bigint,
): Promise<{ readonly payload: unknown; readonly summary: string } | undefined> {
  const pool = waslPool();
  if (pool === undefined) return undefined;
  const r = await pool.query<{ payload: unknown; summary: string }>(
    'select payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [await tenantUuidByCode(pool, tenant), area, asOf.toString()],
  );
  return r.rows[0];
}

const now = (): bigint => hostClockInstant().epochSeconds;

/** The programmes in force and where they came from. */
export async function resolveProgrammes(
  tenant: TenantCode,
  asOf: bigint = now(),
): Promise<Resolved<readonly WaslProgramme[]>> {
  const revised = await effective(tenant, 'PROGRAMMES', asOf);
  if (revised !== undefined)
    return { value: parseWaslProgrammes(revised.payload), source: 'REVISION', revisionSummary: revised.summary };
  const file = loadWaslParties(tenant);
  return { value: file.ok ? ok(file.value.programmes) : file, source: 'FILE' };
}

/** The tenant's Wasl parties with the programmes in force. */
export async function resolveWaslParties(tenant: TenantCode, asOf: bigint = now()): Promise<Result<WaslParties>> {
  const file = loadWaslParties(tenant);
  if (!file.ok) return file;
  const programmes = await resolveProgrammes(tenant, asOf);
  if (!programmes.value.ok) return programmes.value;
  return ok({ ...file.value, programmes: programmes.value.value });
}

/** The board's positions in force and where they came from. */
export async function resolveBoard(tenant: TenantCode, asOf: bigint = now()): Promise<Resolved<BoardPositions>> {
  const revised = await effective(tenant, 'BOARD_POSITIONS', asOf);
  return revised === undefined
    ? { value: loadBoardPositions(tenant), source: 'FILE' }
    : { value: parseBoardPositions(revised.payload), source: 'REVISION', revisionSummary: revised.summary };
}
