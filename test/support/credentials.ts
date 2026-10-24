/**
 * Serve credentials from a given environment map for the rest of a test,
 * whatever the process's database configuration says.
 *
 * Where a database is configured (the CI database suite), the server reads
 * credentials from the vault (services/origination/src/credentials.ts), so a
 * test secret set in process.env is never seen. A test that needs one installs
 * this instead, and the server code under test still reads through its usual
 * credentialProviderFromEnvironment(). Test-only: production has no seam to
 * replace the vault provider.
 */
import { EnvironmentCredentialProvider } from '../../adapters/kernel/credentials-environment.ts';

interface CredentialState {
  provider?: unknown;
}

/** Install an environment provider over `env`; returns the restore function. */
export function serveFromEnvironmentMap(env: Readonly<Record<string, string>>): () => void {
  const state = ((globalThis as { __sanadCredentials?: CredentialState }).__sanadCredentials ??= {});
  const previous = state.provider;
  state.provider = new EnvironmentCredentialProvider(() => undefined, env);
  return () => {
    state.provider = previous;
  };
}
