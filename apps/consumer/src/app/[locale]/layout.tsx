/**
 * The consumer surface shell: one column, phone first, the design system's
 * tokens. `lang` and `dir` are properties of the document and both languages
 * are real routes; everything below uses logical properties, so mirroring is
 * this one attribute changing.
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import { LOCALE_SEGMENTS, htmlLang, isRtl, localeFromSegment, type LocaleSegment } from '@sanad/i18n/strings.ts';
import { currentSession } from '../../server/session.ts';
import { signOutAction } from '../../server/actions.ts';
import '../globals.css';

export const metadata = { title: 'سند — Sanad', description: 'التمويل الشخصي' };

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function ConsumerLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const session = await currentSession();

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-screen-sm items-center gap-3 px-4 py-3">
            <BrandMark size={30} />
            <span className="text-[22px] font-black tracking-tight text-heading">Sanad<span className="text-brand">.</span></span>
            <div className="ms-auto flex items-center gap-2">
              {session !== undefined ? (
                <form action={signOutAction}>
                  <input type="hidden" name="locale" value={segment} />
                  <button type="submit" className="press rounded-pill bg-sunken px-3 py-2 text-xs text-ink-quiet">{arabic ? 'خروج' : 'Sign out'} · <span className="identifier">{session.applicantRef}</span></button>
                </form>
              ) : null}
              <LanguageSwitch current={segment as LocaleSegment} />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-screen-sm px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-screen-sm px-4 pb-8 text-[0.6875rem] text-ink-quiet">
          {arabic ? 'بيئة تطوير: الهوية والدخل والمؤشر بدائل تطويرية موسومة. لا يُخزَّن رقم هوية أو بيانات شخصية.' : 'Development environment: identity, income and benchmark are labelled stand-ins. No national identifier or personal datum is stored.'}
        </footer>
      </body>
    </html>
  );
}
