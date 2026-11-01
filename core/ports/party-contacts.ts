/**
 * Port: where a party's contact details are kept, by contact reference.
 *
 * The notifications port addresses a party by reference and leaves the
 * destination to the adapter (core/ports/notifications.ts). This is where the
 * adapter finds it. The domain records a contact through the service that
 * captured it and carries only the masked forms (core/notifications/contact.ts);
 * `resolve` is for the delivery adapter alone.
 *
 * A contact reference is unique within the tenant because it names where the
 * details were captured as well as who they belong to: the party references an
 * officer keys on two intakes may be the same text and two different people
 * (`contactRefOf` in core/origination/business-intake.ts).
 *
 * A later record for the same reference supersedes the earlier one; nothing is
 * overwritten, so what address a notice went to can always be shown.
 */

import type { ContactDetails } from '../notifications/contact.ts';

export interface PartyContact extends ContactDetails {
  readonly contactRef: string;
  /** Where it was captured (an intake, a consumer journey), by reference. */
  readonly contextRef: string;
  readonly recordedBy: string;
}

export interface PartyContactDirectory {
  /** The current details under this reference in this tenant, or undefined when none were recorded. */
  resolve(contactRef: string): Promise<PartyContact | undefined>;
}
