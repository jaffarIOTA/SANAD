/**
 * An act the signed-in person may or may not perform. Allowed: the form as it
 * is. Not allowed: the same form, every control in it disabled (a disabled
 * fieldset disables its descendants, the submit button included), with the
 * reason in words beside it — shown, not hidden, so a person sees what exists
 * and why it is not theirs to do.
 *
 * A courtesy only. The server action refuses the act regardless of what was
 * drawn (session.ts `authorise`).
 */

import type { ReactElement, ReactNode } from 'react';

import { type WorkbenchAct, permits, refusalWording } from '../../server/authority.ts';
import type { StaffPrincipal } from '../../server/staff.ts';

export function Gate({
  staff,
  act,
  arabic,
  ownWork,
  children,
}: {
  readonly staff: StaffPrincipal | undefined;
  readonly act: WorkbenchAct;
  readonly arabic: boolean;
  /**
   * Set when the signed-in person is the one whose work this act would check
   * (they keyed the figure, presented the document, submitted the case): the
   * act is drawn disabled with the four-eyes reason. The service refuses it
   * regardless.
   */
  readonly ownWork?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const p = permits(staff, act);
  const reason = !p.allowed
    ? refusalWording(p.needs, arabic)
    : ownWork === true
      ? arabic
        ? 'هذا من عملك؛ يتحقق منه أو يبتّ فيه شخص آخر (مبدأ العيون الأربع).'
        : 'This is your own work; another person checks or decides it (four eyes).'
      : undefined;
  if (reason === undefined) return <>{children}</>;
  return (
    <div className="flex flex-col gap-1.5" data-refused-act={act}>
      <fieldset disabled aria-disabled className="m-0 min-w-0 border-0 p-0 opacity-60">
        {children}
      </fieldset>
      <p className="max-w-[60ch] text-[12px] text-ink-quiet">{reason}</p>
    </div>
  );
}

/** The refusal of an act, in the screen's language, for a redirect that came back with AUTHORITY_REQUIRED. */
export function authorityRefusal(
  reason: string | undefined,
  needs: string | undefined,
  arabic: boolean,
): string | undefined {
  if (reason !== 'AUTHORITY_REQUIRED') return undefined;
  const known = ['MAKER', 'CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE', 'FINANCE', 'PLATFORM_ADMIN'] as const;
  const list = (needs ?? '')
    .split(',')
    .filter((n): n is (typeof known)[number] => (known as readonly string[]).includes(n));
  return refusalWording(list.length > 0 ? list : ['CHECKER'], arabic);
}
