// The resolve hook registered by aliases.mjs: an aliased specifier becomes the file it names; anything
// else resolves as Node would.
import { resolveAlias } from './alias-map.mjs';

let aliases = [];

export function initialize(data) {
  aliases = data.aliases;
}

export function resolve(specifier, context, nextResolve) {
  const target = resolveAlias(specifier, aliases);
  return nextResolve(target ?? specifier, context);
}
