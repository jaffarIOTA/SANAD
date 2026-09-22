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
          <div className="flex items-center gap-3 px-5 py-3">
            <BrandMark size={26} />
            <span className="text-base font-semibold tracking-[0.15em]">SANAD</span>
            <span className="text-sm text-ink-quiet">{arabic ? 'العمليات' : 'Operations'}</span>
            <div className="ms-auto">
              <LanguageSwitch current={segment as LocaleSegment} />
            </div>
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
