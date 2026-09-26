/**
 * The operations workbench shell, to the Figma design (BankDash kit, applied
 * 2026-09-26): a 100px white header with the logo, the page title, a search
 * pill, two round icon buttons and the identity disc; a 250px sidebar; the
 * page on a #F5F7FA field. Below the desktop breakpoint the sidebar becomes
 * the design's bottom bar and the search drops under the header.
 *
 * Composed in logical properties: Arabic is the design default and English
 * is the mirror. The Figma frames are LTR; this is their RTL composition.
 */

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { BrandMark, LanguageSwitch } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { LOCALE_SEGMENTS, htmlLang, isRtl, localeFromSegment, type LocaleSegment } from '@sanad/i18n/strings.ts';
import { BottomNav, SideNav } from './SideNav.tsx';
import '../globals.css';

export const metadata = { title: 'Sanad — Operations', description: 'Origination and review' };

export function generateStaticParams(): { locale: LocaleSegment }[] {
  return LOCALE_SEGMENTS.map((locale) => ({ locale }));
}

export default async function OpsLayout({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';

  const search = (
    <form action={`/${segment}`} method="get" role="search" className="w-full lg:w-[255px]">
      <label className="flex h-[50px] items-center gap-3 rounded-pill bg-sunken ps-6 pe-4 focus-within:ring-2 focus-within:ring-brand/40">
        <Icon name="search" size={20} className="shrink-0 text-ink-quiet" />
        <span className="sr-only">{arabic ? 'بحث في الطلبات' : 'Search requests'}</span>
        <input type="search" name="q" autoComplete="off" placeholder={arabic ? 'ابحث عن شيء' : 'Search for something'} className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-[#8ba3cb]" />
      </label>
    </form>
  );

  return (
    <html lang={htmlLang(locale)} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh bg-page text-ink antialiased">
        <header className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="flex h-[70px] items-center gap-4 px-4 lg:h-[100px] lg:px-0">
            <a href={`/${segment}`} className="flex w-auto items-center gap-3 lg:w-[250px] lg:ps-[38px]">
              <BrandMark size={36} />
              <span className="text-[25px] font-black tracking-tight text-heading">Sanad<span className="text-brand">.</span></span>
            </a>
            <h1 className="hidden text-h1 font-semibold text-heading lg:block lg:ps-10">{arabic ? 'نظرة عامة' : 'Overview'}</h1>
            <div className="ms-auto hidden lg:block">{search}</div>
            <div className="ms-auto flex items-center gap-3 lg:ms-0 lg:gap-[30px] lg:pe-10">
              <a href={`/${segment}/products`} title={arabic ? 'المنتجات' : 'Products'} className="press hidden size-[50px] items-center justify-center rounded-full bg-sunken text-ink-quiet hover:text-brand lg:inline-flex">
                <Icon name="settings" size={22} />
              </a>
              <a href={`/${segment}/queue`} title={arabic ? 'قائمة المراجعة' : 'Review queue'} className="press relative hidden size-[50px] items-center justify-center rounded-full bg-sunken text-ink-quiet hover:text-brand lg:inline-flex">
                <Icon name="bell" size={22} />
                <span aria-hidden className="absolute end-[14px] top-[13px] size-2 rounded-full bg-blocked-mark ring-2 ring-surface" />
              </a>
              <LanguageSwitch current={segment as LocaleSegment} />
              {/*
                Who you are acting as. Under four eyes the maker may not be the
                checker, so the identity a screen acts under is operational
                information. This build holds both development identities at
                once, and says so rather than presenting a tidy single user.
              */}
              <div className="flex items-center gap-3" title={arabic ? 'مُدخِل ومُراجِع معاً — لا يجوز في الإنتاج' : 'maker and checker — not permitted in production'}>
                <span aria-hidden className="inline-flex size-[44px] items-center justify-center rounded-full bg-brand-wash text-xs font-bold text-brand lg:size-[60px]">DEV</span>
                <span className="hidden flex-col leading-tight xl:flex">
                  <span className="text-sm font-medium text-heading">{arabic ? 'جلسة تطوير' : 'Development session'}</span>
                  <span className="text-[0.6875rem] text-attention">{arabic ? 'مُدخِل ومُراجِع معاً' : 'maker and checker'}</span>
                </span>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 lg:hidden">{search}</div>
        </header>

        <div className="flex min-h-[calc(100dvh-100px)]">
          <SideNav segment={segment} arabic={arabic} current={`/${segment}`} />
          <main className="min-w-0 flex-1 overflow-x-clip px-4 pb-24 pt-6 lg:px-10 lg:pb-10">{children}</main>
        </div>
        <BottomNav segment={segment} arabic={arabic} current={`/${segment}`} />
      </body>
    </html>
  );
}
