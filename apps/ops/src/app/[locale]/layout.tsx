/**
 * The operations workbench shell.
 *
 * Denser than the counterparty surface, and English-leading by default,
 * because the people here work in it all day and switch between cases. The
 * Arabic route is complete all the same — parity of content is a requirement,
 * not a courtesy to the primary persona (NFR-07).
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import {
  LOCALE_SEGMENTS,
  htmlLang,
  isRtl,
  localeFromSegment,
  type LocaleSegment,
} from '@sanad/i18n/strings.ts';
import { SideNav } from './SideNav.tsx';
import '../globals.css';

export const metadata = {
  title: 'Sanad — Operations',
  description: 'Origination and review',
};

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function OpsLayout({
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

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-sunken text-ink antialiased">
        <header className="border-b border-line bg-surface">
          <div className="flex flex-wrap items-center gap-3 px-5 py-3">
            <BrandMark size={26} />
            <span className="text-base font-semibold tracking-[0.15em]">SANAD</span>
            <span className="text-sm text-ink-quiet">{arabic ? 'العمليات' : 'Operations'}</span>

            {/*
              A real filter, not header decoration. A plain GET form, so it
              works with JavaScript off and the result is a linkable URL —
              which is what an operator actually wants when handing a case to
              a colleague.
            */}
            <form action={`/${segment}`} method="get" role="search" className="ms-auto">
              <label className="flex min-h-tap items-center gap-2 rounded-card border border-line bg-sunken ps-3 pe-1 focus-within:border-brand-strong">
                <Icon name="search" size={16} className="shrink-0 text-ink-quiet" />
                <span className="sr-only">
                  {arabic ? 'بحث في الطلبات' : 'Search requests'}
                </span>
                <input
                  type="search"
                  name="q"
                  autoComplete="off"
                  placeholder={
                    arabic ? 'رقم طلب أو عميل أو فاتورة' : 'Request, counterparty or invoice'
                  }
                  className="w-56 bg-transparent py-1.5 pe-2 text-sm text-ink outline-none placeholder:text-ink-quiet"
                />
              </label>
            </form>

            {/*
              Who you are acting as. Not an avatar for its own sake: under
              four eyes the maker may not be the checker, so the identity a
              screen acts under is operational information. This build holds
              both development identities at once, and says so rather than
              presenting a tidy single user that does not exist yet.
            */}
            <div className="flex items-center gap-2 border-s border-line ps-3">
              <span
                aria-hidden
                className="inline-flex size-8 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-deep"
              >
                DEV
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-sm font-medium text-ink">
                  {arabic ? 'جلسة تطوير' : 'Development session'}
                </span>
                <span className="text-[0.6875rem] text-attention">
                  {arabic
                    ? 'مُدخِل ومُراجِع معاً — لا يجوز في الإنتاج'
                    : 'maker and checker — not permitted in production'}
                </span>
              </span>
            </div>

            <LanguageSwitch current={segment as LocaleSegment} />
          </div>
        </header>

        <div className="flex min-h-[calc(100dvh-3.5rem)]">
          <SideNav segment={segment} arabic={arabic} current={`/${segment}`} />
          <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
