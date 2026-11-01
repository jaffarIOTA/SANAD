/**
 * A party's contact details: what an officer keys, what the platform keeps,
 * and what the domain is allowed to carry.
 *
 * The real address and number are personal data. They are normalised here,
 * stored once against the party reference (core/ports/party-contacts.ts), and
 * read back only by the delivery adapter. Everything else — the application,
 * its events, the offer notice, a screen — carries the masked form this module
 * derives, which is exactly what `isMaskedEmail` and `isMaskedMobile` accept.
 *
 * A refusal names the field, never the value.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import { isMaskedEmail, isMaskedMobile } from './offer-notification.ts';

export interface ContactDetails {
  /** Lower-cased domain; the local part as given. */
  readonly email?: string;
  /** E.164: '+', the country code, the national number. No spaces. */
  readonly mobile?: string;
}

export interface MaskedContact {
  readonly emailMasked?: string;
  readonly mobileMasked?: string;
}

const refuse = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

/** A conservative address: no quoting, no comments, no IP-literal domains. */
const EMAIL = /^([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/;

/**
 * ITU-T E.164 country codes of one and two digits. Every other code is three
 * digits, so the code's length is known from its leading digits alone.
 */
const TWO_DIGIT_CODES = new Set([
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);

function countryCodeLength(digits: string): number {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

/** The email as stored: trimmed, domain lower-cased. Undefined when it is not an address. */
export function normaliseEmail(raw: string): string | undefined {
  const m = EMAIL.exec(raw.trim());
  if (m === null) return undefined;
  return `${m[1] ?? ''}@${(m[2] ?? '').toLowerCase()}`;
}

/**
 * The mobile number as stored, in E.164. Spaces, dashes, dots and brackets are
 * ignored; a leading '00' is read as '+'. A number without its country code is
 * refused rather than guessed.
 */
export function normaliseMobile(raw: string): string | undefined {
  const compact = raw.trim().replaceAll(/[\s().-]/g, '');
  const plus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(plus)) return undefined;
  const digits = plus.slice(1);
  const national = digits.slice(countryCodeLength(digits));
  return national.length >= 7 ? plus : undefined;
}

/** 'a***@example.com': the first character, then asterisks, then the domain. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** '+966 50 XXX XXXX': the country code, two national digits, the rest masked. */
export function maskMobile(mobile: string): string {
  const digits = mobile.slice(1);
  const cc = digits.slice(0, countryCodeLength(digits));
  const national = digits.slice(cc.length);
  const hidden = 'X'.repeat(national.length - 2);
  return `+${cc} ${national.slice(0, 2)} ${hidden.slice(0, 3)} ${hidden.slice(3)}`.trimEnd();
}

/**
 * Normalise what an officer keyed and derive the masked forms. At least one
 * channel is required: a contact who cannot be reached is not a contact.
 */
export function contactFrom(raw: {
  readonly email?: string;
  readonly mobile?: string;
}): Result<{ readonly details: ContactDetails; readonly masked: MaskedContact }> {
  const emailRaw = raw.email?.trim() ?? '';
  const mobileRaw = raw.mobile?.trim() ?? '';
  if (emailRaw === '' && mobileRaw === '')
    return refuse('CONTACT_NO_CHANNEL', 'An email address or a mobile number is recorded');
  const email = emailRaw === '' ? undefined : normaliseEmail(emailRaw);
  if (emailRaw !== '' && email === undefined) return refuse('CONTACT_EMAIL_INVALID', 'The email address is not valid');
  const mobile = mobileRaw === '' ? undefined : normaliseMobile(mobileRaw);
  if (mobileRaw !== '' && mobile === undefined)
    return refuse('CONTACT_MOBILE_INVALID', 'The mobile number is in international form, with its country code');
  const masked: MaskedContact = {
    ...(email === undefined ? {} : { emailMasked: maskEmail(email) }),
    ...(mobile === undefined ? {} : { mobileMasked: maskMobile(mobile) }),
  };
  // The masks are what the rest of the platform checks; a mask it would refuse is a defect here.
  if (masked.emailMasked !== undefined && !isMaskedEmail(masked.emailMasked))
    return refuse('CONTACT_EMAIL_INVALID', 'The email address is not valid');
  if (masked.mobileMasked !== undefined && !isMaskedMobile(masked.mobileMasked))
    return refuse('CONTACT_MOBILE_INVALID', 'The mobile number is in international form, with its country code');
  return ok({
    details: { ...(email === undefined ? {} : { email }), ...(mobile === undefined ? {} : { mobile }) },
    masked,
  });
}
