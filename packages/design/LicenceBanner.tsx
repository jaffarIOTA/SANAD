/**
 * The licence banner on staff screens (ADR 0006 §4): while the installation's
 * licence is expiring, in grace, or blocking new business. The words come from
 * `core/licensing/explain.ts`; this component only renders them, in the
 * screen's language, in logical properties.
 */

import type { ReactElement } from 'react';

export interface LicenceBannerProps {
  readonly banner: { readonly tone: 'attention' | 'blocked'; readonly en: string; readonly ar: string } | undefined;
  readonly arabic: boolean;
  /** Where the administrators renew it; absent on a surface that has no link to the Admin app. */
  readonly href?: string;
}

export function LicenceBanner({ banner, arabic, href }: LicenceBannerProps): ReactElement | null {
  if (banner === undefined) return null;
  const tone =
    banner.tone === 'blocked' ? 'border-blocked/30 bg-blocked-wash text-ink' : 'border-attention/30 bg-attention-wash';
  return (
    <div
      role={banner.tone === 'blocked' ? 'alert' : 'status'}
      data-testid="licence-banner"
      data-tone={banner.tone}
      className={`border-b px-4 py-2.5 text-[14px] lg:px-8 ${tone}`}
    >
      <span className="font-semibold">{arabic ? 'الترخيص: ' : 'Licence: '}</span>
      {arabic ? banner.ar : banner.en}
      {href === undefined ? null : (
        <>
          {' '}
          <a href={href} className="font-medium text-brand underline underline-offset-2">
            {arabic ? 'عرض الترخيص' : 'View the licence'}
          </a>
        </>
      )}
    </div>
  );
}
