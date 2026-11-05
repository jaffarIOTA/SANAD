/**
 * Jurisdictions (ADR 0005).
 *
 * Sanad serves institutions in the Kingdom of Saudi Arabia and in the United
 * Arab Emirates. Which rules, currency, calendars and rails apply to a piece
 * of work is decided by one thing: the jurisdiction the institution was
 * onboarded under. It is recorded once, on the tenant, and everything else is
 * derived from it — never passed in a request body, never inferred from an
 * amount, never chosen per screen.
 *
 * A jurisdiction profile is regulatory data held as configuration with its
 * citations (`config/jurisdictions/ksa.json`, `uae.json`). This file holds the shape and
 * the parser, and no figures. It names no regulator's rule numbers, no rail
 * and no vendor: those are configuration and adapters.
 */

import { type CurrencyCode, CURRENCY_CODES } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type JurisdictionCode = 'SA' | 'AE';
export const JURISDICTION_CODES: readonly JurisdictionCode[] = ['SA', 'AE'];

/** Calendars in which a date with contractual effect must be shown. */
export type Calendar = 'GREGORIAN' | 'HIJRI';

/** What kind of institution was onboarded. It decides which of the jurisdiction's rulebooks bind it. */
export type LicenceType = 'BANK' | 'FINANCE_COMPANY' | 'DEVELOPMENT_FUND' | 'FINTECH';
export const LICENCE_TYPES: readonly LicenceType[] = ['BANK', 'FINANCE_COMPANY', 'DEVELOPMENT_FUND', 'FINTECH'];

export interface JurisdictionProfile {
  readonly code: JurisdictionCode;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly currency: CurrencyCode;
  /** IANA zone used to render instants; never used to decide anything. */
  readonly timeZone: string;
  readonly contractualCalendars: readonly Calendar[];
  /** The supervisory authority, by short code, and its name. */
  readonly regulator: { readonly code: string; readonly nameEn: string; readonly nameAr: string };
  /** Adapter codes allowed per capability in this jurisdiction (the rails configuration may choose only from these). */
  readonly railAdapters: Readonly<Record<string, readonly string[]>>;
  /** Where this jurisdiction's regulatory definitions live, relative to `config/regulatory/`. */
  readonly regulatoryDirectory: string;
  /**
   * How a consumer instalment may be collected in this jurisdiction, and which capability carries each
   * channel. A channel the jurisdiction does not list cannot be offered to a customer here: a Saudi bill
   * scheme is not a UAE collection method, and the reverse.
   */
  readonly collectionChannels: Readonly<Partial<Record<CollectionChannel, string>>>;
  /** Each regulatory figure the profile itself states carries its source here. */
  readonly citations: readonly string[];
}

/**
 * The ways an instalment can be collected, named by mechanism, never by scheme: which scheme carries a
 * channel (a national bill scheme, a direct-debit system, an open-banking framework) is the jurisdiction's
 * configuration. `OWN_ACCOUNT` is the institution debiting the customer's own account in its core.
 */
export type CollectionChannel = 'BILL_PRESENTMENT' | 'DIRECT_DEBIT' | 'CARD' | 'PAYMENT_INITIATION' | 'OWN_ACCOUNT';
export const COLLECTION_CHANNELS: readonly CollectionChannel[] = [
  'BILL_PRESENTMENT',
  'DIRECT_DEBIT',
  'CARD',
  'PAYMENT_INITIATION',
  'OWN_ACCOUNT',
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function parseJurisdictionProfile(raw: unknown): Result<JurisdictionProfile> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!isRecord(raw)) return bad('JURISDICTION_MALFORMED', 'A jurisdiction profile is an object');
  const code = raw['code'];
  if (!JURISDICTION_CODES.includes(code as JurisdictionCode)) return bad('JURISDICTION_CODE', 'code is SA or AE');
  if (!nonEmpty(raw['nameEn']) || !nonEmpty(raw['nameAr']))
    return bad('JURISDICTION_NAME', 'nameEn and nameAr are required');
  if (!CURRENCY_CODES.includes(raw['currency'] as CurrencyCode))
    return bad('JURISDICTION_CURRENCY', 'currency is a supported ISO 4217 code');
  if (!nonEmpty(raw['timeZone'])) return bad('JURISDICTION_TIME_ZONE', 'timeZone is an IANA zone');
  const calendars = raw['contractualCalendars'];
  if (
    !Array.isArray(calendars) ||
    calendars.length === 0 ||
    !calendars.every((c) => c === 'GREGORIAN' || c === 'HIJRI') ||
    !calendars.includes('GREGORIAN')
  )
    return bad('JURISDICTION_CALENDARS', 'contractualCalendars lists GREGORIAN and, where required, HIJRI');
  const regulator = raw['regulator'];
  if (
    !isRecord(regulator) ||
    !nonEmpty(regulator['code']) ||
    !nonEmpty(regulator['nameEn']) ||
    !nonEmpty(regulator['nameAr'])
  )
    return bad('JURISDICTION_REGULATOR', 'regulator has a code and both names');
  const rails = raw['railAdapters'];
  if (!isRecord(rails) || !Object.values(rails).every((list) => Array.isArray(list) && list.every(nonEmpty)))
    return bad('JURISDICTION_RAILS', 'railAdapters maps each capability to a list of adapter codes');
  if (!nonEmpty(raw['regulatoryDirectory']) || !/^[a-z]{2}$/.test(raw['regulatoryDirectory']))
    return bad('JURISDICTION_REGULATORY_DIR', 'regulatoryDirectory is the two-letter folder under config/regulatory');
  const channels = raw['collectionChannels'] ?? {};
  if (
    !isRecord(channels) ||
    !Object.entries(channels).every(
      ([channel, capability]) =>
        COLLECTION_CHANNELS.includes(channel as CollectionChannel) &&
        nonEmpty(capability) &&
        Object.hasOwn(rails, capability),
    )
  )
    return bad(
      'JURISDICTION_COLLECTION_CHANNELS',
      'collectionChannels maps each collection channel to a capability this jurisdiction lists in railAdapters',
    );
  const citations = raw['citations'];
  if (!Array.isArray(citations) || !citations.every((c) => nonEmpty(c) && c.length >= 10))
    return bad('JURISDICTION_CITATIONS', 'citations lists the sources of the profile’s regulatory statements');
  return ok({
    code: code as JurisdictionCode,
    nameEn: raw['nameEn'],
    nameAr: raw['nameAr'],
    currency: raw['currency'] as CurrencyCode,
    timeZone: raw['timeZone'],
    contractualCalendars: calendars as Calendar[],
    regulator: { code: regulator['code'], nameEn: regulator['nameEn'], nameAr: regulator['nameAr'] },
    railAdapters: rails as Record<string, string[]>,
    regulatoryDirectory: raw['regulatoryDirectory'],
    collectionChannels: channels as Partial<Record<CollectionChannel, string>>,
    citations: citations as string[],
  });
}

/**
 * What the institution told us when it was onboarded, and what the platform
 * therefore applies to it. Recorded on the tenant (migration 0013); the
 * checked-in tenant file is the same record for environments without a
 * database. The base currency must be the jurisdiction's: an institution
 * cannot be onboarded in Abu Dhabi with riyal books.
 */
export interface TenantOnboarding {
  readonly tenantCode: string;
  readonly legalNameEn: string;
  readonly legalNameAr: string;
  readonly jurisdiction: JurisdictionCode;
  readonly licenceType: LicenceType;
  readonly baseCurrency: CurrencyCode;
  /** Whether the institution offers Islamic products, conventional ones, or both. */
  readonly window: 'ISLAMIC' | 'CONVENTIONAL' | 'BOTH';
}

export function parseTenantOnboarding(
  raw: unknown,
  profiles: Readonly<Record<JurisdictionCode, JurisdictionProfile>>,
): Result<TenantOnboarding> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!isRecord(raw)) return bad('ONBOARDING_MALFORMED', 'An onboarding record is an object');
  if (!nonEmpty(raw['tenantCode']) || !/^[a-z][a-z0-9-]{1,40}$/.test(raw['tenantCode']))
    return bad('ONBOARDING_TENANT_CODE', 'tenantCode is a lower-case slug');
  if (!nonEmpty(raw['legalNameEn']) || !nonEmpty(raw['legalNameAr']))
    return bad('ONBOARDING_LEGAL_NAME', 'legalNameEn and legalNameAr are required');
  const jurisdiction = raw['jurisdiction'];
  if (!JURISDICTION_CODES.includes(jurisdiction as JurisdictionCode))
    return bad('ONBOARDING_JURISDICTION', 'jurisdiction is SA or AE');
  if (!LICENCE_TYPES.includes(raw['licenceType'] as LicenceType))
    return bad('ONBOARDING_LICENCE', 'licenceType is BANK, FINANCE_COMPANY, DEVELOPMENT_FUND or FINTECH');
  const profile = profiles[jurisdiction as JurisdictionCode];
  if (raw['baseCurrency'] !== profile.currency) {
    return reject(
      'OP-DETERMINACY',
      'ONBOARDING_CURRENCY_NOT_JURISDICTION',
      'The base currency is the jurisdiction’s currency',
      { jurisdiction: String(jurisdiction), expected: profile.currency, given: String(raw['baseCurrency']) },
    );
  }
  const window = raw['window'];
  if (window !== 'ISLAMIC' && window !== 'CONVENTIONAL' && window !== 'BOTH')
    return bad('ONBOARDING_WINDOW', 'window is ISLAMIC, CONVENTIONAL or BOTH');
  return ok({
    tenantCode: raw['tenantCode'],
    legalNameEn: raw['legalNameEn'],
    legalNameAr: raw['legalNameAr'],
    jurisdiction: jurisdiction as JurisdictionCode,
    licenceType: raw['licenceType'] as LicenceType,
    baseCurrency: profile.currency,
    window,
  });
}
