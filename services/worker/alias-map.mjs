// tsconfig.json's `paths` as the resolve hook needs them; pure, so a test can check it.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Each `"@x/*": ["./dir/*"]` alias as [prefix, directory URL], longest prefix first. */
export function aliasesFrom(tsconfigText, rootDir) {
  const paths = JSON.parse(tsconfigText).compilerOptions?.paths ?? {};
  return Object.entries(paths)
    .filter(([alias, targets]) => alias.endsWith('/*') && targets.length === 1 && targets[0].endsWith('/*'))
    .map(([alias, [target]]) => [alias.slice(0, -1), `${pathToFileURL(join(rootDir, target.slice(0, -2))).href}/`])
    .sort((a, b) => b[0].length - a[0].length);
}

/** The file URL an aliased specifier names, or undefined when no alias applies. */
export function resolveAlias(specifier, aliases) {
  const hit = aliases.find(([prefix]) => specifier.startsWith(prefix));
  return hit === undefined ? undefined : hit[1] + specifier.slice(hit[0].length);
}
