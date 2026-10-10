/** Types for the hosted exposed-schema check (SR-041), so the architecture suite can import its rule. */
export declare const EXPECTED: readonly string[];
export declare function parseSchemas(dbSchema: unknown): string[];
export declare function verdict(schemas: readonly string[]): string[];
export declare function exposedSchemas(input: {
  readonly ref: string | undefined;
  readonly token: string | undefined;
  readonly fetchImpl?: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}): Promise<string[]>;
