/** Types for the alias map, so the architecture suite can check it. */
export declare function aliasesFrom(tsconfigText: string, rootDir: string): [string, string][];
export declare function resolveAlias(specifier: string, aliases: readonly [string, string][]): string | undefined;
