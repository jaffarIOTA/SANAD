/**
 * The Shariah parameters in force for a tenant at a moment (SR-025): the
 * approved BOARD_POSITIONS and STRUCTURES revisions, else the checked-in files.
 * A revision reaches here only after a second person approved it
 * (`config.revision_four_eyes`) and only from its effective moment.
 *
 * Every structure is held to the board positions in force at the same moment:
 * a structure under another approval or below the board's risk floor does not
 * load, whichever source it came from.
 */

import type { Pool } from 'pg';

import { type TenantCode, loadBoardPositions, loadStructureDefinition } from '../../../config/loader.ts';
import { type Result, reject } from '../../../core/kernel/result.ts';
import {
  type BoardPositions,
  parseBoardPositions,
  structureWithinBoard,
} from '../../../products/murabaha-scf/structures/board-positions.ts';
import {
  type StructureDefinition,
  parseStructureDefinition,
} from '../../../products/murabaha-scf/structures/definition.ts';

import { tenantUuidByCode } from './credentials.ts';

async function effective(pool: Pool, tenant: TenantCode, area: string, asOf: bigint): Promise<unknown> {
  const r = await pool.query<{ payload: unknown }>(
    'select payload from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [await tenantUuidByCode(pool, tenant), area, asOf.toString()],
  );
  return r.rows[0]?.payload;
}

export async function resolveBoardPositions(
  pool: Pool | undefined,
  tenant: TenantCode,
  asOfEpochSeconds: bigint,
): Promise<Result<BoardPositions>> {
  const revised = pool === undefined ? undefined : await effective(pool, tenant, 'BOARD_POSITIONS', asOfEpochSeconds);
  return revised === undefined ? loadBoardPositions(tenant) : parseBoardPositions(revised);
}

/** A STRUCTURES revision carries the tenant's whole set of structure definitions. */
export async function resolveStructure(
  pool: Pool | undefined,
  tenant: TenantCode,
  definitionId: string,
  asOfEpochSeconds: bigint,
): Promise<Result<StructureDefinition>> {
  const board = await resolveBoardPositions(pool, tenant, asOfEpochSeconds);
  if (!board.ok) return board;
  const revised = pool === undefined ? undefined : await effective(pool, tenant, 'STRUCTURES', asOfEpochSeconds);
  if (revised === undefined) {
    const fromFile = loadStructureDefinition(tenant, definitionId);
    return fromFile.ok ? structureWithinBoard(fromFile.value, board.value) : fromFile;
  }
  if (!Array.isArray(revised))
    return reject('OP-DETERMINACY', 'STRUCTURES_REVISION_MALFORMED', 'A structures revision is a list of definitions');
  for (const candidate of revised) {
    const parsed = parseStructureDefinition(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.definitionId === definitionId) return structureWithinBoard(parsed.value, board.value);
  }
  return reject(
    'SH-17',
    'STRUCTURE_DEFINITION_NOT_FOUND',
    'No approved structure definition of that identifier is in force',
    {
      tenant,
      definitionId,
    },
  );
}
