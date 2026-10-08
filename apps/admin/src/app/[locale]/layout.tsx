/**
 * The administration shell: the workbench's header and sidebar, in the
 * kit's styles, with the areas an institution configures. Arabic first,
 * mirrored to English.
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import { LOCALE_SEGMENTS, htmlLang, isRtl, localeFromSegment, type LocaleSegment } from '@sanad/i18n/strings.ts';

import { currentAdmin } from '../../server/session.ts';
import { signOutAction } from '../../server/actions.ts';
import { SideNav } from './SideNav.tsx';
import '../globals.css';

export const metadata = { title: 'Sanad — Administration', description: 'Tenant configuration and credentials' };

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function AdminLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const admin = await currentAdmin();

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="flex h-[70px] items-center gap-4 px-4 lg:h-[100px] lg:px-0">
            <a href={`/${segment}`} className="flex w-auto items-center gap-3 lg:w-[250px] lg:ps-[38px]">
              <BrandMark size={36} />
              <span className="text-[25px] font-black tracking-tight text-heading">
                Sanad<span className="text-brand">.</span>
              </span>
            </a>
            <h1 className="hidden text-h1 font-semibold text-heading lg:block lg:ps-10">
              {arabic ? 'الإدارة' : 'Administration'}
            </h1>
            <div className="ms-auto flex items-center gap-3 lg:gap-[30px] lg:pe-10">
              <LanguageSwitch current={segment as LocaleSegment} />
              {admin !== undefined ? (
                <form action={signOutAction} className="flex items-center gap-3">
                  <input type="hidden" name="locale" value={segment} />
                  <span
                    aria-hidden
                    className="inline-flex size-[44px] items-center justify-center rounded-full bg-brand-wash text-xs font-bold text-brand lg:size-[60px]"
                  >
                    ADM
                  </span>
                  <span className="hidden flex-col leading-tight xl:flex">
                    <span className="text-sm font-medium text-heading">
                      <span className="identifier">{admin.principalId}</span>
                    </span>
                    <span className="text-[0.6875rem] text-attention">
                      {arabic ? 'جلسة تطوير · ٣٠ دقيقة' : 'development session · 30 min'}
                    </span>
                  </span>
                  <button type="submit" className="press rounded-pill bg-sunken px-3 py-2 text-xs text-ink-quiet">
                    {arabic ? 'خروج' : 'Sign out'}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </header>
        <div className="flex min-h-[calc(100dvh-100px)]">
          <SideNav segment={segment} arabic={arabic} signedIn={admin !== undefined} />
          <main className="min-w-0 flex-1 overflow-x-clip px-4 pb-10 pt-6 lg:px-10">{children}</main>
        </div>
      </body>
    </html>
  );
}
