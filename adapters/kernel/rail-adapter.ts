/**
 * The rail adapter base, shared by every jurisdiction's rails (ADR 0005).
 *
 * The implementation was written for the Saudi rails and still lives at
 * `adapters/ksa/kernel/rail-adapter.ts`, where those adapters import it. This
 * module is the jurisdiction-neutral name for it: the UAE rails import from
 * here, so when the implementation moves into this directory only this file
 * changes and neither jurisdiction's adapters do.
 */

export {
  type Body,
  RailAdapter,
  type RailAdapterConfig,
  bool,
  decimalToMinor,
  epoch,
  int,
  malformed,
  str,
} from '../ksa/kernel/rail-adapter.ts';
