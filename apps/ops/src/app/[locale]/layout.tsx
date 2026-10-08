/**
 * The operations workbench shell, to the Figma "Loan management web
 * application" kit (Loan Officer VD, applied 2026-10-08): a slim 64px app bar
 * with the mark, where you are, search, the icon buttons and who you are; a
 * labelled sidebar (the kit's icon rail, widened, because this platform has
 * forty modules and an unlabelled rail of forty icons is a guessing game);
 * the page on the kit's pale neutral field. Below the desktop breakpoint the
 * sidebar becomes a bottom bar and the search drops under the header.
 *
 * Fonts are self-hosted by Next.js at build time, so a staff browser never
 * calls a font CDN at run time.
 *
 * Composed in logical properties: Arabic is the design default and English
 * is the mirror. The Figma frames are LTR; this is their RTL composition.
 */

import type { ReactNode } from 'react';
import { DM_Sans, Noto_Kufi_Arabic } from 'next/font/google';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { LOCALE_SEGMENTS, htmlLang, isRtl, localeFromSegment, type LocaleSegment } from '@sanad/i18n/strings.ts';
import { HeaderTitle } from './HeaderTitle.tsx';
import { BottomNav, SideNav } from './SideNav.tsx';
import { workbenchJurisdiction } from '../../server/jurisdiction.ts';
import { developmentAttestation, syncOriginationPolicy, syncStore } from '../../server/store.ts';
import '../globals.css';

export const metadata = { title: 'Sanad — Operations', description: 'Origination and review' };

const dmSans = DM_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], variable: '--font-dm-sans', display: 'swap' });
const notoKufi = Noto_Kufi_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600', '700'], variable: '--font-noto-kufi', display: 'swap' });

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function OpsLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  // The policy the workbench acts under is the approved revision in force at this moment.
  await syncOriginationPolicy(developmentAttestation().epochSeconds);
  // The request book is loaded from the database once per process, and anything changed is written before the page reads it.
  await syncStore();
  // Which jurisdiction the whole deployment behaves as (Admin → Jurisdiction, ADR 0005).
  const jurisdiction = await workbenchJurisdiction();

  const search = (
    <form action={`/${segment}`} method="get" role="search" className="w-full lg:w-[320px]">
      <label className="flex h-10 items-center gap-2.5 rounded-tile border border-line bg-sunken ps-3.5 pe-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
        <Icon name="search" size={18} className="shrink-0 text-ink-quiet" />
        <span className="sr-only">{arabic ? 'بحث في الطلبات' : 'Search requests'}</span>
        <input type="search" name="q" autoComplete="off" placeholder={arabic ? 'ابحث برقم الطلب أو العميل أو الفاتورة' : 'Search by request, counterparty or invoice'} className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-quiet" />
      </label>
    </form>
  );

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'} className={`${dmSans.variable} ${notoKufi.variable}`}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="flex h-16 items-center gap-4 px-4 lg:px-0">
            <a href={`/${segment}`} className="flex w-auto items-center gap-2.5 lg:w-[248px] lg:ps-6">
              <BrandMark size={30} />
              <span className="text-[20px] font-bold tracking-tight text-heading">Sanad</span>
            </a>
            <p className="hidden text-[14px] font-medium text-ink-quiet lg:block lg:ps-8"><HeaderTitle arabic={arabic} /></p>
            <span title={arabic ? 'الولاية التي يعمل بها التطبيق — تُغيَّر من تطبيق الإدارة' : 'The jurisdiction the application behaves as — changed in the Admin app'} className="hidden items-center gap-1.5 rounded-pill border border-line bg-sunken px-3 py-1 text-[12px] font-semibold text-heading md:inline-flex">
              <span aria-hidden className="size-1.5 rounded-full bg-positive-mark" />
              {jurisdiction.code === 'AE' ? (arabic ? 'الإمارات' : 'UAE') : (arabic ? 'السعودية' : 'KSA')} · <span className="identifier">{jurisdiction.currency}</span>
            </span>
            <div className="ms-auto hidden lg:block">{search}</div>
            <div className="ms-auto flex items-center gap-2 lg:ms-4 lg:gap-3 lg:pe-8">
              <a href={`/${segment}/products`} title={arabic ? 'المنتجات' : 'Products'} className="press hidden size-9 items-center justify-center rounded-tile text-ink-quiet hover:bg-sunken hover:text-brand lg:inline-flex">
                <Icon name="settings" size={20} />
              </a>
              <a href={`/${segment}/queue`} title={arabic ? 'قائمة المراجعة' : 'Review queue'} className="press relative hidden size-9 items-center justify-center rounded-tile text-ink-quiet hover:bg-sunken hover:text-brand lg:inline-flex">
                <Icon name="bell" size={20} />
                <span aria-hidden className="absolute end-2 top-2 size-2 rounded-full bg-blocked-mark ring-2 ring-surface" />
              </a>
              <LanguageSwitch current={segment as LocaleSegment} />
              <span aria-hidden className="mx-1 hidden h-7 w-px bg-line lg:block" />
              {/*
                Who you are acting as. Under four eyes the maker may not be the
                checker, so the identity a screen acts under is operational
                information. This build holds both development identities at
                once, and says so rather than presenting a tidy single user.
              */}
              <div className="flex items-center gap-2.5" title={arabic ? 'مُدخِل ومُراجِع معاً — لا يجوز في الإنتاج' : 'maker and checker — not permitted in production'}>
                <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-full bg-brand-wash text-[11px] font-bold text-brand-deep">DEV</span>
                <span className="hidden flex-col leading-tight xl:flex">
                  <span className="text-[13px] font-semibold text-heading">{arabic ? 'جلسة تطوير' : 'Development session'}</span>
                  <span className="text-[11px] text-attention">{arabic ? 'مُدخِل ومُراجِع معاً' : 'maker and checker'}</span>
                </span>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 lg:hidden">{search}</div>
        </header>

        <div className="flex min-h-[calc(100dvh-64px)]">
          <SideNav segment={segment} arabic={arabic} jurisdiction={jurisdiction.code} />
          <main className="min-w-0 flex-1 overflow-x-clip px-4 pb-24 pt-6 lg:px-8 lg:pb-10 lg:pt-8">{children}</main>
        </div>
        <BottomNav segment={segment} arabic={arabic} jurisdiction={jurisdiction.code} />
      </body>
    </html>
  );
}
