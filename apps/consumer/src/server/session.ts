/**
 * The applicant's session: the identity assertion reference from the rail
 * and the applicant reference the platform uses. No identifier, no name.
 *
 * Development: a plain cookie. Production: an encrypted, signed session
 * bound to the assertion and its expiry, issued by the identity step.
 */

import { cookies } from 'next/headers';

export interface ConsumerSession {
  readonly applicantRef: string;
  readonly identityAssertionId: string;
  readonly identityRef: string;
}

const COOKIE = 'sanad_consumer_dev';

export async function currentSession(): Promise<ConsumerSession | undefined> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsumerSession>;
    return typeof parsed.applicantRef === 'string' && typeof parsed.identityAssertionId === 'string' && typeof parsed.identityRef === 'string' ? (parsed as ConsumerSession) : undefined;
  } catch {
    return undefined;
  }
}

export async function setSession(session: ConsumerSession): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify(session), { httpOnly: true, sameSite: 'lax', path: '/' });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
