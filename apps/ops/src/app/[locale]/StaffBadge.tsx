/**
 * Who is signed in: the person, the institution the identity belongs to, the
 * authorities it holds, and Sign out. Read from the session on the server;
 * nothing here is a control, it is so a person always knows whose hands an act
 * is in.
 */

import type { ReactElement } from 'react';

import { authorityLabel } from '../../server/authority.ts';
import { signOutAction } from '../../server/auth-actions.ts';
import type { StaffPrincipal } from '../../server/staff.ts';

/** Initials from the authorities, never from a name (there is none to show). */
const initials = (staff: StaffPrincipal): string => {
  const first = staff.authorities[0];
  if (first === 'CREDIT_COMMITTEE') return 'CC';
  if (first === 'SENIOR_CHECKER') return 'SC';
  if (first === 'PLATFORM_ADMIN') return 'PA';
  return (first ?? '?').slice(0, 2);
};

export function StaffBadge({
  staff,
  segment,
  arabic,
}: {
  readonly staff: StaffPrincipal;
  readonly segment: string;
  readonly arabic: boolean;
}): ReactElement {
  const authorities = staff.authorities.map((a) => authorityLabel(a, arabic)).join(arabic ? '، ' : ', ');
  return (
    <form action={signOutAction} className="flex items-center gap-2.5" data-signed-in-as={staff.principalId}>
      <input type="hidden" name="locale" value={segment} />
      <span
        aria-hidden
        className="inline-flex size-9 items-center justify-center rounded-full bg-brand-wash text-[11px] font-bold text-brand-deep"
      >
        {initials(staff)}
      </span>
      <span className="hidden flex-col leading-tight xl:flex">
        <bdi dir="ltr" className="identifier text-[13px] font-semibold text-heading">
          {staff.principalId}
        </bdi>
        <span className="text-[11px] text-ink-quiet">
          <bdi dir="ltr" className="identifier">
            {staff.tenantId}
          </bdi>
          {' · '}
          {authorities}
        </span>
      </span>
      <span className="sr-only">
        {arabic
          ? `مسجّل الدخول باسم ${staff.principalId} لدى ${staff.tenantId}، الصلاحيات: ${authorities}`
          : `Signed in as ${staff.principalId} at ${staff.tenantId}; authorities: ${authorities}`}
      </span>
      <button
        type="submit"
        className="press rounded-pill bg-sunken px-3 py-1.5 text-[12px] font-semibold text-ink-quiet hover:text-heading"
      >
        {arabic ? 'خروج' : 'Sign out'}
      </button>
    </form>
  );
}
