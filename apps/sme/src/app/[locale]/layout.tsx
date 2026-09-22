/**
 * The SME surface shell.
 *
 * This is the root layout, sitting under the locale segment, because `lang`
 * and `dir` are properties of the document and both languages are real routes
 * rather than one route with a toggle. Direction is set once here; every
 * component below is written with logical properties, so mirroring the whole
 * layout is this one attribute changing (SDD §7.5, AP-10).
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import {
  LOCALE_SEGMENTS,
  STRINGS,
  htmlLang,
  isRtl,
  localeFromSegment,
  type LocaleSegment,
} from '@sanad/i18n/strings.ts';
import '../globals.css';

export const metadata = {
  title: 'وصل — Wasl',
  description: 'تمويل سلاسل الإمداد المتوافق مع الشريعة',
};

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const t = STRINGS[locale];

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-screen-sm items-center gap-3 px-4 py-3">
            <BrandMark size={28} />
            <span className="text-lg font-semibold">{t.appName}</span>
            <div className="ms-auto">
              <LanguageSwitch current={segment as LocaleSegment} />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-screen-sm px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
