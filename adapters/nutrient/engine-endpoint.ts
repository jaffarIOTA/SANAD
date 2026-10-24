/**
 * Where the tenant's Document Engine is, and the token to call it with, read
 * from the vault on every call (capability DOCUMENT_PLATFORM:
 * document_engine_base_url, document_engine_api_token) and never cached,
 * logged or returned. The engine is reached over https, or over plain http
 * only on the loopback interface (a developer's local engine).
 *
 * Shared by the adapters that call the engine: generation and signing.
 */
import type { CredentialProvider } from '../../core/ports/credentials.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type EngineEndpoint =
  | { readonly ok: true; readonly base: URL; readonly token: string }
  | { readonly ok: false; readonly reason: 'DOCUMENT_ENGINE_NOT_CONFIGURED' | 'DOCUMENT_ENGINE_URL_INVALID' };

export async function engineEndpoint(
  credentials: CredentialProvider,
  tenantId: string,
  environment: 'sandbox' | 'uat' | 'production',
  correlationId: string,
): Promise<EngineEndpoint> {
  const read = async (keyName: string) =>
    (await credentials.get({ tenantId, provider: 'DOCUMENT_PLATFORM', environment, keyName }, correlationId)).expose();
  let base: string;
  let token: string;
  try {
    [base, token] = await Promise.all([read('document_engine_base_url'), read('document_engine_api_token')]);
  } catch {
    return { ok: false, reason: 'DOCUMENT_ENGINE_NOT_CONFIGURED' };
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, reason: 'DOCUMENT_ENGINE_URL_INVALID' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    return { ok: false, reason: 'DOCUMENT_ENGINE_URL_INVALID' };
  return { ok: true, base: url, token };
}

/** The engine's own header form, confirmed in V-02 (adapters/nutrient/verification/README.md). */
export const engineAuthorization = (token: string): string => `Token token=${token}`;
