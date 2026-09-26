/**
 * The module map.
 *
 * Every capability the platform is specified to have, taken from the service
 * decomposition at SDD §4.4 and the information architecture at §7.3 — not
 * from what happens to be built. A navigation that only lists finished screens
 * hides the shape of the product; one that lists everything as though it
 * worked is worse.
 *
 * So each entry carries its readiness, and the sidebar shows it. A delivery
 * lead should be able to open this and see the whole surface area and how much
 * of it is real, without asking anyone.
 *
 * Two entries are not merely unbuilt but **governed** — held pending a Board
 * ruling, or excluded from this phase by the specification. Those are marked
 * differently from "we have not got to it yet", because they are different
 * things and conflating them is how an exclusion quietly becomes a backlog
 * item.
 */

import type { IconName } from '@sanad/design/icons.tsx';

export type ModuleReadiness =
  /** Usable now. */
  | { readonly kind: 'LIVE' }
  /** Specified, not yet built. Ordinary backlog. */
  | { readonly kind: 'NOT_BUILT' }
  /** Waiting on something outside engineering. */
  | { readonly kind: 'BLOCKED'; readonly on: string }
  /** Excluded from this phase by the specification, not by us. */
  | { readonly kind: 'EXCLUDED_THIS_PHASE'; readonly basis: string };

export interface ModuleItem {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Relative to the locale segment. Absent where there is nothing to open. */
  readonly href?: string;
  readonly readiness: ModuleReadiness;
  /** Where the specification defines it. */
  readonly reference: string;
}

export interface ModuleGroup {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Beside the group heading, never instead of it. */
  readonly icon: IconName;
  readonly items: readonly ModuleItem[];
}

const live = (): ModuleReadiness => ({ kind: 'LIVE' });
const soon = (): ModuleReadiness => ({ kind: 'NOT_BUILT' });

export const MODULE_GROUPS: readonly ModuleGroup[] = [
  {
    id: 'origination',
    icon: 'key-in',
    titleEn: 'Origination',
    titleAr: 'إنشاء الطلبات',
    items: [
      {
        id: 'dashboard',
        titleEn: 'Dashboard',
        titleAr: 'لوحة العمليات',
        href: '',
        readiness: live(),
        reference: 'SDD §7.3',
      },
      {
        id: 'key-request',
        titleEn: 'Key a request',
        titleAr: 'إدخال طلب',
        href: '/originate',
        readiness: live(),
        reference: 'BR-D01',
      },
      {
        id: 'review-queue',
        titleEn: 'Review queue',
        titleAr: 'قائمة المراجعة',
        href: '/queue',
        readiness: live(),
        reference: 'Four eyes · SDD §7.4.3',
      },
      {
        id: 'partner-api',
        titleEn: 'Partner API',
        titleAr: 'واجهة الشركاء',
        // No screen: an ERP calls it. Live because a request raised over it
        // lands in the same queue as every other channel.
        readiness: live(),
        reference: 'SDD §6.3 · POST /api/origination/v1/requests',
      },
      {
        id: 'embedded',
        titleEn: 'Embedded nomination',
        titleAr: 'الترشيح المدمج',
        href: '/originate',
        readiness: live(),
        reference: 'Aggregator channel · merchant mandate required',
      },
    ],
  },
  {
    id: 'products',
    icon: 'store',
    titleEn: 'Products',
    titleAr: 'المنتجات',
    items: [
      { id: 'catalogue', titleEn: 'Catalogue & disclosure', titleAr: 'الكتالوج والإفصاح', href: '/products', readiness: live(), reference: 'CLAUDE.md §3 · §4.2 — tenant catalogue, quote, APR, disclosure' },
      { id: 'murabaha-scf', titleEn: 'Murabaha SCF (Wasl)', titleAr: 'مرابحة سلاسل الإمداد (وصل)', readiness: live(), reference: 'products/murabaha-scf — trade-first, profit amount' },
      { id: 'tawarruq-personal', titleEn: 'Personal finance (Tawarruq)', titleAr: 'التمويل الشخصي (تورّق)', readiness: live(), reference: 'products/tawarruq-personal — module built; broker adapter fixture-only; thresholds carry placeholder citations' },
      { id: 'bnpl', titleEn: 'BNPL', titleAr: 'اشترِ الآن وادفع لاحقاً', readiness: live(), reference: 'products/bnpl — module built; merchant onboarding and checkout API not built; consumer limit carries a placeholder citation' },
      { id: 'embedded-lending', titleEn: 'Embedded lending', titleAr: 'التمويل المدمج', readiness: live(), reference: 'products/embedded-lending — module built on the partner channel; partner settlement reconciliation not built' },
      { id: 'conventional-term', titleEn: 'Conventional term loan', titleAr: 'قرض لأجل تقليدي', readiness: live(), reference: 'products/conventional-term — module built; affordability cap carries a placeholder citation' },
    ],
  },
  {
    id: 'rails',
    icon: 'plug',
    titleEn: 'KSA integration rails',
    titleAr: 'قنوات التكامل السعودية',
    items: [
      { id: 'nafath', titleEn: 'Nafath', titleAr: 'نفاذ', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/nafath/README.md' }, reference: 'identity-authentication port — adapter needs sandbox access' },
      { id: 'yakeen', titleEn: 'Yakeen', titleAr: 'يقين', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/yakeen/README.md' }, reference: 'identity-verification port' },
      { id: 'tahaqoq', titleEn: 'Tahaqoq', titleAr: 'تحقق', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/tahaqoq/README.md' }, reference: 'document-verification port — scope to confirm with provider' },
      { id: 'simah', titleEn: 'SIMAH', titleAr: 'سمة', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/simah/README.md' }, reference: 'credit-bureau port — query and mandatory reporting' },
      { id: 'bayan', titleEn: 'Bayan', titleAr: 'بيان', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/bayan/README.md' }, reference: 'credit-bureau port — second implementation' },
      { id: 'wathq', titleEn: 'Wathq', titleAr: 'واثق', readiness: soon(), reference: 'counterparty-registry port' },
      { id: 'gosi', titleEn: 'GOSI', titleAr: 'التأمينات الاجتماعية', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/gosi/README.md' }, reference: 'employment-verification port' },
      { id: 'zatca', titleEn: 'ZATCA', titleAr: 'هيئة الزكاة والضريبة والجمارك', readiness: { kind: 'BLOCKED', on: 'tax-status adapter built on fixtures; e-invoicing adapter not built' }, reference: 'e-invoicing + tax-compliance ports' },
      { id: 'open-banking', titleEn: 'Open Banking', titleAr: 'المصرفية المفتوحة', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/open-banking/README.md' }, reference: 'account-information + payment-initiation ports' },
      { id: 'sadad', titleEn: 'SADAD', titleAr: 'سداد', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/sadad/README.md' }, reference: 'bill-collection port' },
      { id: 'payments-hub', titleEn: 'Payments hub', titleAr: 'مركز المدفوعات', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/payments-hub/README.md' }, reference: 'payments port — SARIE, mada, internal' },
      { id: 'rate-publisher', titleEn: 'Rate publisher', titleAr: 'ناشر الأسعار', readiness: { kind: 'BLOCKED', on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/rate-publisher/README.md' }, reference: 'rate-publisher port — benchmarks and market APRs' },
    ],
  },
  {
    id: 'counterparty',
    icon: 'people',
    titleEn: 'Counterparty',
    titleAr: 'العملاء',
    items: [
      { id: 'onboarding', titleEn: 'Onboarding', titleAr: 'التسجيل', readiness: soon(), reference: 'BR-B01' },
      { id: 'verification', titleEn: 'Verification exceptions', titleAr: 'استثناءات التحقق', readiness: soon(), reference: 'BR-B08' },
      { id: 'screening', titleEn: 'Screening hits', titleAr: 'نتائج الفحص', readiness: soon(), reference: 'BR-B03' },
      { id: 'consents', titleEn: 'Consents', titleAr: 'الموافقات', readiness: soon(), reference: 'BR-B04 · RC-05' },
    ],
  },
  {
    id: 'decisioning',
    icon: 'gauge',
    titleEn: 'Decisioning & limits',
    titleAr: 'القرار والحدود',
    items: [
      { id: 'decisions', titleEn: 'Decisions & traces', titleAr: 'القرارات وسجلاتها', readiness: soon(), reference: 'BR-C03 — engine built, no screen' },
      { id: 'policy', titleEn: 'Credit policy', titleAr: 'سياسة الائتمان', readiness: soon(), reference: 'BR-C08 — versions in config/' },
      { id: 'facilities', titleEn: 'Facilities & limits', titleAr: 'التسهيلات والحدود', readiness: soon(), reference: 'SDD §6.7' },
      { id: 'concentration', titleEn: 'Concentration', titleAr: 'التركّز', readiness: soon(), reference: 'BR-C07' },
    ],
  },
  {
    id: 'transactions',
    icon: 'exchange',
    titleEn: 'Transactions',
    titleAr: 'المعاملات',
    items: [
      { id: 'drawdowns', titleEn: 'Drawdowns', titleAr: 'عمليات السحب', readiness: soon(), reference: 'SDD §5.5.1' },
      { id: 'sequencing', titleEn: 'Sequencing & gates', titleAr: 'التسلسل والبوابات', readiness: soon(), reference: 'SH-05 · SH-06 — engine built' },
      { id: 'evidence', titleEn: 'Evidence', titleAr: 'الأدلة', readiness: soon(), reference: 'SDD §5.4.3' },
      { id: 'registry', titleEn: 'Financed invoice registry', titleAr: 'سجل الفواتير الممولة', readiness: soon(), reference: 'SH-10' },
      { id: 'matching', titleEn: 'Matching exceptions', titleAr: 'استثناءات المطابقة', readiness: soon(), reference: 'BR-D06' },
    ],
  },
  {
    id: 'documents',
    icon: 'document',
    titleEn: 'Documents',
    titleAr: 'المستندات',
    items: [
      { id: 'templates', titleEn: 'Templates & versions', titleAr: 'القوالب والإصدارات', readiness: soon(), reference: 'BR-G02' },
      {
        id: 'generated',
        titleEn: 'Generated documents',
        titleAr: 'المستندات الصادرة',
        readiness: { kind: 'BLOCKED', on: 'Document platform licence scope — Web SDK alone, or with Document Engine.' },
        reference: 'OI-05',
      },
      {
        id: 'signature',
        titleEn: 'Signature & seal',
        titleAr: 'التوقيع والختم',
        readiness: { kind: 'BLOCKED', on: 'OI-06 — no validated long-term-validation signed document exists yet.' },
        reference: 'OI-06 · BR-G04',
      },
      { id: 'drift', titleEn: 'Template drift', titleAr: 'انحراف القوالب', readiness: soon(), reference: 'BR-F07' },
    ],
  },
  {
    id: 'settlement',
    icon: 'banknote',
    titleEn: 'Settlement',
    titleAr: 'التسوية',
    items: [
      { id: 'instructions', titleEn: 'Instructions', titleAr: 'أوامر التسوية', readiness: soon(), reference: 'BR-D11' },
      { id: 'reconciliation', titleEn: 'Reconciliation', titleAr: 'المطابقة', readiness: soon(), reference: 'SDD §6.10' },
      { id: 'returns', titleEn: 'Returns', titleAr: 'المرتجعات', readiness: soon(), reference: 'SDD §4.4' },
    ],
  },
  {
    id: 'lifecycle',
    icon: 'cycle',
    titleEn: 'Lifecycle',
    titleAr: 'دورة الحياة',
    items: [
      { id: 'obligations', titleEn: 'Obligations & schedules', titleAr: 'الالتزامات والجداول', readiness: soon(), reference: 'SH-02 — domain built' },
      { id: 'reschedule', titleEn: 'Reschedule', titleAr: 'إعادة الجدولة', readiness: soon(), reference: 'BR-E02' },
      { id: 'hardship', titleEn: 'Hardship', titleAr: 'التعثّر والإعسار', readiness: soon(), reference: 'SH-14 · BR-E05' },
      {
        id: 'embedded-collection',
        titleEn: 'Embedded collection',
        titleAr: 'التحصيل المدمج',
        readiness: soon(),
        reference: 'Embedded lending module — revenue-linked collection where the tenant policy permits it; OI-23 remains open for Islamic tenants only (ADR 0002)',
      },
    ],
  },
  {
    id: 'shariah',
    icon: 'shield-check',
    titleEn: 'Shariah governance',
    titleAr: 'الحوكمة الشرعية',
    items: [
      { id: 'approvals', titleEn: 'Approvals register', titleAr: 'سجل الاعتمادات', readiness: soon(), reference: 'BR-F01 · SH-17' },
      { id: 'audit', titleEn: 'Audit workspace', titleAr: 'مساحة التدقيق الشرعي', readiness: soon(), reference: 'BR-F05 · SH-18' },
      { id: 'incidents', titleEn: 'Incidents', titleAr: 'المخالفات', readiness: soon(), reference: 'BR-F04' },
      { id: 'purification', titleEn: 'Charity ledger & purification', titleAr: 'سجل الخير والتطهير', readiness: soon(), reference: 'SH-13 · BR-F06 — domain built' },
    ],
  },
  {
    id: 'programmes',
    icon: 'building',
    titleEn: 'Programmes',
    titleAr: 'البرامج',
    items: [
      { id: 'anchors', titleEn: 'Anchors', titleAr: 'الشركات الراعية', readiness: soon(), reference: 'BR-A01' },
      { id: 'programmes', titleEn: 'Programmes & limits', titleAr: 'البرامج والحدود', readiness: soon(), reference: 'BR-A02' },
      { id: 'goods', titleEn: 'Goods register', titleAr: 'سجل البضائع', readiness: soon(), reference: 'SH-11' },
      {
        id: 'commodity',
        titleEn: 'Commodity brokers',
        titleAr: 'وسطاء السلع',
        readiness: soon(),
        reference: 'Tawarruq module — commodity broker port; enabled per tenant by its board ruling (ADR 0002 reverses PR-X2)',
      },
    ],
  },
  {
    id: 'administration',
    icon: 'settings',
    titleEn: 'Administration',
    titleAr: 'الإدارة',
    items: [
      { id: 'users', titleEn: 'Users & entitlements', titleAr: 'المستخدمون والصلاحيات', readiness: soon(), reference: 'SDD §4.7 — catalogue built' },
      { id: 'configuration', titleEn: 'Configuration', titleAr: 'الإعدادات', readiness: soon(), reference: 'NFR-13' },
      { id: 'tenants', titleEn: 'Tenants', titleAr: 'المؤسسات', readiness: soon(), reference: 'NFR-12' },
    ],
  },
];

/** Counts for the sidebar footer, so the shape of the work is visible at a glance. */
export function readinessTally(): Readonly<Record<ModuleReadiness['kind'], number>> {
  const tally = { LIVE: 0, NOT_BUILT: 0, BLOCKED: 0, EXCLUDED_THIS_PHASE: 0 };
  for (const group of MODULE_GROUPS) {
    for (const item of group.items) tally[item.readiness.kind] += 1;
  }
  return tally;
}
