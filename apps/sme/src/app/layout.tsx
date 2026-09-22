/**
 * The SME surface shell.
 *
 * Arabic is the default, and the direction is set at the document root rather
 * than sprinkled through components (SDD §7.5). Switching to English mirrors
 * the whole layout, because every component underneath is written with logical
 * properties.
 */

import type { ReactNode } from 'react';

import { BrandMark } from '../design/primitives.tsx';
import { STRINGS, htmlLang, isRtl, type Locale } from '../i18n/strings.ts';
import './globals.css';

export const metadata = {
  title: 'وصل — Wasl',
  description: 'تمويل سلاسل الإمداد المتوافق مع الشريعة',
};

/**
 * Arabic-first: the default locale is Arabic, and English is the alternative.
 * Later this comes from the authenticated principal's preference.
 */
const LOCALE: Locale = 'ar-SA';

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const t = STRINGS[LOCALE];

  return (
    <html lang={htmlLang(LOCALE)} dir={isRtl(LOCALE) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-screen-sm items-center gap-3 px-4 py-3">
            <BrandMark size={28} />
            <span className="text-lg font-semibold">{t.appName}</span>
          </div>
        </header>
        <main className="mx-auto max-w-screen-sm px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
