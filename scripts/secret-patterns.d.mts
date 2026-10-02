/** Types for the secret scanner, so the architecture suite can import the patterns it enforces. */
export declare const SECRET_SHAPED: RegExp;
export declare const OPAQUE_ASSIGNMENT: RegExp;
export declare const CREDENTIAL_FILE: RegExp;
export declare const PLACEHOLDER: RegExp;
export declare const KEY_FILE: RegExp;
export declare const PEM_BLOCK: RegExp;
export declare const isTrackedEnvFile: (path: string) => boolean;
export declare function findSecrets(path: string, content: string): string[];
