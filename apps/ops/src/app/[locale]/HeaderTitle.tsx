'use client';

/**
 * The header's page title, as the Figma frames have it: "Overview",
 * "Transactions", "Loans", "Setting" — one word for where you are. Read
 * from the path on the client, because the root layout does not know the
 * route; it renders nothing until it does, so there is no wrong title first.
 */

import { usePathname } from 'next/navigation';

const TITLES: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  '': { en: 'Overview', ar: 'نظرة عامة' },
  queue: { en: 'Review queue', ar: 'قائمة المراجعة' },
  requests: { en: 'Request', ar: 'الطلب' },
  products: { en: 'Products', ar: 'المنتجات' },
  originate: { en: 'Key a request', ar: 'إدخال طلب' },
};

export function HeaderTitle({ arabic }: { readonly arabic: boolean }) {
  const pathname = usePathname();
  const section = pathname.split('/').filter(Boolean)[1] ?? '';
  const title = TITLES[section] ?? TITLES[''];
  return <>{arabic ? title?.ar : title?.en}</>;
}
