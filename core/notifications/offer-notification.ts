/**
 * Offer notifications: the email and the SMS that tell an applicant a Facility
 * Offer Letter is ready to sign.
 *
 * Both reference the letter's version (its content hash) and a signing-link
 * placeholder that the delivery adapter fills with a single-use link; the
 * domain never holds the link itself. Recipients appear only as masked display
 * strings ('+971 50 XXX XXXX', 'a***@example.com'): the adapter resolves the
 * real destination from the party reference (core/ports/notifications.ts).
 *
 * `previewOfferNotifications` returns exactly what would be sent;
 * `buildOfferNotifications` is the same function, so a preview and a send
 * cannot drift. No identity number ever appears in either message.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import { type OfferLetter, containsIdentityPattern, displayVersion, letterRow } from '../documents/offer-letter.ts';

export const SIGNING_LINK_PLACEHOLDER = '{{SIGNING_LINK}}';

export interface OfferNotificationRecipient {
  /** The party the adapter resolves the destination from. Not a contact detail. */
  readonly partyRef: string;
  /** Masked display only, e.g. 'a***@example.com'. */
  readonly emailMasked?: string;
  /** Masked display only, e.g. '+971 50 XXX XXXX'. */
  readonly mobileMasked?: string;
}

export interface OfferEmail {
  readonly channel: 'EMAIL';
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface OfferSms {
  readonly channel: 'SMS';
  readonly to: string;
  readonly body: string;
}

export interface OfferNotifications {
  readonly partyRef: string;
  readonly letterVersion: string;
  readonly letterReference: string;
  readonly email?: OfferEmail;
  readonly sms?: OfferSms;
}

/** First character, then only asterisks, before the domain. */
const MASKED_EMAIL = /^[^\s@*]\*{3,}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/** Country code, then groups of digits or X, with at least four X and at most four visible digits after the code. */
const MASKED_MOBILE = /^\+\d{1,3}( [0-9X]+)+$/;

export function isMaskedEmail(s: string): boolean {
  return MASKED_EMAIL.test(s);
}

export function isMaskedMobile(s: string): boolean {
  if (!MASKED_MOBILE.test(s)) return false;
  const rest = s.slice(s.indexOf(' ') + 1);
  const masked = (rest.match(/X/g) ?? []).length;
  const visible = (rest.match(/\d/g) ?? []).length;
  return masked >= 4 && visible <= 4;
}

const refuse = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

export function previewOfferNotifications(
  letter: OfferLetter,
  recipient: OfferNotificationRecipient,
): Result<OfferNotifications> {
  if (recipient.partyRef.trim().length === 0) return refuse('OFFER_NOTICE_PARTY', 'A party reference is required');
  if (recipient.emailMasked === undefined && recipient.mobileMasked === undefined) {
    return refuse('OFFER_NOTICE_NO_CHANNEL', 'At least one of email or SMS is addressed');
  }
  if (recipient.emailMasked !== undefined && !isMaskedEmail(recipient.emailMasked)) {
    return refuse('OFFER_NOTICE_UNMASKED_EMAIL', 'An email recipient is carried masked only');
  }
  if (recipient.mobileMasked !== undefined && !isMaskedMobile(recipient.mobileMasked)) {
    return refuse('OFFER_NOTICE_UNMASKED_MOBILE', 'A mobile recipient is carried masked only');
  }

  // English lines take the English values (Latin digits); Arabic lines the Arabic values (Arabic-Indic digits).
  // The reference and the version are identifiers and stay Latin in both.
  const amount = letterRow(letter, 'FACILITY_AMOUNT')?.value.en ?? '';
  const amountAr = letterRow(letter, 'FACILITY_AMOUNT')?.value.ar ?? '';
  const tenor = letterRow(letter, 'TENOR');
  const rate = letterRow(letter, 'RATE');
  const instalment = letterRow(letter, 'INSTALMENT')?.value.en ?? '';
  const fullVersion = displayVersion(letter.version);
  const shortVersion = displayVersion(letter.version, 2);
  const validEn = letter.validUntil.gregorian.en;
  const validAr =
    letter.validUntil.hijri === undefined
      ? letter.validUntil.gregorian.ar
      : `${letter.validUntil.gregorian.ar} (${letter.validUntil.hijri})`;

  const email: OfferEmail | undefined =
    recipient.emailMasked === undefined
      ? undefined
      : {
          channel: 'EMAIL',
          to: recipient.emailMasked,
          subject: `${letter.title.en} ${letter.reference} — ${letter.parties.lender.en} | ${letter.title.ar}`,
          body: [
            `Dear ${letter.parties.borrower.en},`,
            '',
            `${letter.parties.lender.en} is pleased to offer your business the following facility (${letter.productVariant.en}):`,
            `- Facility amount: ${amount}`,
            `- Tenor: ${tenor?.value.en ?? ''}`,
            `- ${rate?.label.en ?? ''}: ${rate?.value.en ?? ''}`,
            `- Monthly instalment: ${instalment}`,
            '',
            `This offer is valid until ${validEn}. Please review and sign the offer letter here: ${SIGNING_LINK_PLACEHOLDER}`,
            `Offer letter reference ${letter.reference}, version ${fullVersion}.`,
            '',
            '— ملخص بالعربية —',
            `السادة ${letter.parties.borrower.ar}،`,
            `يسر ${letter.parties.lender.ar} أن تعرض على منشأتكم تمويل ${letter.productVariant.ar} بمبلغ ${amountAr} لمدة ${tenor?.value.ar ?? ''}، ${rate?.label.ar ?? ''} ${rate?.value.ar ?? ''}.`,
            `العرض ساري حتى ${validAr}. للاطلاع والتوقيع: ${SIGNING_LINK_PLACEHOLDER}`,
            `مرجع الخطاب ${letter.reference}، الإصدار ${fullVersion}.`,
          ].join('\n'),
        };

  const sms: OfferSms | undefined =
    recipient.mobileMasked === undefined
      ? undefined
      : {
          channel: 'SMS',
          to: recipient.mobileMasked,
          body: [
            `${letter.parties.lender.ar}: عرض تمويل بمبلغ ${amountAr} جاهز للتوقيع حتى ${validAr}. ${SIGNING_LINK_PLACEHOLDER} (مرجع ${letter.reference}، إصدار ${shortVersion})`,
            `${letter.parties.lender.en}: your facility offer of ${amount} is ready to sign until ${validEn}. ${SIGNING_LINK_PLACEHOLDER} (Ref ${letter.reference}, v ${shortVersion})`,
          ].join('\n'),
        };

  const texts = [email?.subject, email?.body, sms?.body].filter((t): t is string => t !== undefined);
  if (texts.some(containsIdentityPattern)) {
    return refuse('OFFER_NOTICE_IDENTITY_NUMBER', 'A notification never carries an identity number');
  }

  return ok({
    partyRef: recipient.partyRef,
    letterVersion: letter.version,
    letterReference: letter.reference,
    ...(email === undefined ? {} : { email }),
    ...(sms === undefined ? {} : { sms }),
  });
}

/** What the outbox enqueues. Identical to the preview by construction. */
export const buildOfferNotifications = previewOfferNotifications;
