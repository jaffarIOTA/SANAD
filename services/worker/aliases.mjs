// The repository's import aliases (`@sanad/core/…`, `@sanad/origination/…`) for plain Node.
//
// The apps resolve them through Next's bundler and the tests through Vitest; a
// process that runs the TypeScript sources directly — the workflow worker — has
// neither. This registers a resolve hook that maps each alias exactly as
// tsconfig.json's `paths` does, read from that file so the two cannot drift.
//
//   node --experimental-transform-types --import ./services/worker/aliases.mjs services/worker/main.ts
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasesFrom } from './alias-map.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

register('./alias-hooks.mjs', import.meta.url, {
  data: { aliases: aliasesFrom(readFileSync(join(root, 'tsconfig.json'), 'utf8'), root) },
});
