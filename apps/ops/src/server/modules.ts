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

/** The deployment jurisdictions a module can be listed under (ADR 0005). */
export type ModuleJurisdiction = 'SA' | 'AE';

export interface ModuleItem {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Relative to the locale segment. Absent where there is nothing to open. */
  readonly href?: string;
  readonly readiness: ModuleReadiness;
  /** Where the specification defines it. */
  readonly reference: string;
  /** The jurisdictions this item exists in. Absent: every jurisdiction its group is listed in. */
  readonly jurisdictions?: readonly ModuleJurisdiction[];
}

export interface ModuleGroup {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Beside the group heading, never instead of it. */
  readonly icon: IconName;
  readonly items: readonly ModuleItem[];
  /** The jurisdictions this group exists in. Absent: platform-wide. */
  readonly jurisdictions?: readonly ModuleJurisdiction[];
}

const live = (): ModuleReadiness => ({ kind: 'LIVE' });
const soon = (): ModuleReadiness => ({ kind: 'NOT_BUILT' });

/** Saudi only: the Saudi products and rails, the Murabaha SCF (Wasl) workstreams. */
const SA: readonly ModuleJurisdiction[] = ['SA'];
/** UAE only: the UAE rails and the UAE SME direct-lending items. */
const AE: readonly ModuleJurisdiction[] = ['AE'];

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
        // The aggregator channel nominates under a merchant mandate (the Saudi BNPL rails).
        jurisdictions: SA,
      },
    ],
  },
  {
    id: 'products',
    icon: 'store',
    titleEn: 'Products',
    titleAr: 'المنتجات',
    items: [
      {
        id: 'catalogue',
        titleEn: 'Catalogue & disclosure',
        titleAr: 'الكتالوج والإفصاح',
        href: '/products',
        readiness: live(),
        reference: 'CLAUDE.md §3 · §4.2 — tenant catalogue, quote, APR, disclosure',
      },
      {
        id: 'murabaha-scf',
        jurisdictions: SA,
        titleEn: 'Murabaha SCF (Wasl)',
        titleAr: 'مرابحة سلاسل الإمداد (وصل)',
        readiness: live(),
        reference: 'products/murabaha-scf — trade-first, profit amount',
      },
      {
        id: 'tawarruq-personal',
        jurisdictions: SA,
        titleEn: 'Personal finance (Tawarruq)',
        titleAr: 'التمويل الشخصي (تورّق)',
        readiness: live(),
        reference:
          'products/tawarruq-personal — module built; broker adapter fixture-only; thresholds carry placeholder citations',
      },
      {
        id: 'bnpl',
        jurisdictions: SA,
        titleEn: 'BNPL',
        titleAr: 'اشترِ الآن وادفع لاحقاً',
        readiness: live(),
        reference:
          'products/bnpl — module, merchant onboarding (core/merchants) and checkout API (api/openapi/checkout.v1.yaml, apps/consumer) built; ceilings cite the SAMA BNPL Rules (Nov 2023) Art. 20 and 22',
      },
      {
        id: 'merchants',
        jurisdictions: SA,
        titleEn: 'Merchants & checkout',
        titleAr: 'التجار والدفع عند الشراء',
        href: '/merchants',
        readiness: live(),
        reference:
          'core/merchants on PostgreSQL (core.merchant): onboard, verify under four eyes and a store contract (SAMA BNPL Rules Art. 27), suspend, reinstate, close; the checkout API reads the same rows. Registry and screening references are typed until those rails are live.',
      },
      {
        id: 'embedded-lending',
        jurisdictions: SA,
        titleEn: 'Embedded lending',
        titleAr: 'التمويل المدمج',
        readiness: live(),
        reference:
          'products/embedded-lending — module and partner settlement reconciliation (core/reconciliation) built; settlement feed adapter not built',
      },
      {
        id: 'conventional-term',
        jurisdictions: SA,
        titleEn: 'Conventional term loan',
        titleAr: 'قرض لأجل تقليدي',
        readiness: live(),
        reference: 'products/conventional-term — module built; affordability cap carries a placeholder citation',
      },
      {
        id: 'sme-term-conventional',
        titleEn: 'SME term finance',
        titleAr: 'تمويل المنشآت لأجل',
        readiness: live(),
        reference:
          'products/sme-term-conventional — module built; size by the SAMA SME definition (config/regulatory/sme-definition.json); DSCR and revenue-share limits are tenant credit policy, illustrative until the bank supplies its own; Kafalah coverage a placeholder',
      },
      {
        id: 'sme-term-islamic',
        titleEn: 'SME finance (Tawarruq)',
        titleAr: 'تمويل المنشآت (تورّق)',
        readiness: live(),
        reference:
          'products/sme-term-islamic — module built; disabled in both tenants until each board ruling is recorded through Admin; same SME rules as the conventional module',
      },
    ],
  },
  {
    id: 'rails',
    jurisdictions: SA,
    icon: 'plug',
    titleEn: 'KSA integration rails',
    titleAr: 'قنوات التكامل السعودية',
    items: [
      {
        id: 'nafath',
        titleEn: 'Nafath',
        titleAr: 'نفاذ',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/nafath/README.md',
        },
        reference: 'identity-authentication port — adapter needs sandbox access',
      },
      {
        id: 'yakeen',
        titleEn: 'Yakeen',
        titleAr: 'يقين',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/yakeen/README.md',
        },
        reference: 'identity-verification port',
      },
      {
        id: 'tahaqoq',
        titleEn: 'Tahaqoq',
        titleAr: 'تحقق',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/tahaqoq/README.md',
        },
        reference:
          'document-verification port — scope to confirm with provider. Asked about Saudi business uploads whose checklist item declares AUTHENTIC, under the intake’s DOCUMENT_VERIFICATION consent (document intelligence D3); FIXTURE until KSA-RAIL-TAHAQOQ-01',
      },
      {
        id: 'simah',
        titleEn: 'SIMAH',
        titleAr: 'سمة',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/simah/README.md',
        },
        reference: 'credit-bureau port — query and mandatory reporting',
      },
      {
        id: 'bayan',
        titleEn: 'Bayan',
        titleAr: 'بيان',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/bayan/README.md',
        },
        reference: 'credit-bureau port — second implementation',
      },
      { id: 'wathq', titleEn: 'Wathq', titleAr: 'واثق', readiness: soon(), reference: 'business-registry port' },
      {
        id: 'gosi',
        titleEn: 'GOSI',
        titleAr: 'التأمينات الاجتماعية',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/gosi/README.md',
        },
        reference: 'employment-verification port',
      },
      {
        id: 'zatca',
        titleEn: 'ZATCA',
        titleAr: 'هيئة الزكاة والضريبة والجمارك',
        readiness: {
          kind: 'BLOCKED',
          on: 'tax-status and e-invoicing adapters built on fixtures; live sandbox call not yet made — see adapters/ksa/zatca-einvoicing/README.md',
        },
        reference: 'e-invoicing + tax-compliance ports',
      },
      {
        id: 'open-banking',
        titleEn: 'Open Banking',
        titleAr: 'المصرفية المفتوحة',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/open-banking/README.md',
        },
        reference: 'account-information + payment-initiation ports',
      },
      {
        id: 'sadad',
        titleEn: 'SADAD',
        titleAr: 'سداد',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/sadad/README.md',
        },
        reference: 'bill-collection port',
      },
      {
        id: 'payments-hub',
        titleEn: 'Payments hub',
        titleAr: 'مركز المدفوعات',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/payments-hub/README.md',
        },
        reference: 'payments port — SARIE, mada, internal',
      },
      {
        id: 'rate-publisher',
        titleEn: 'Rate publisher',
        titleAr: 'ناشر الأسعار',
        readiness: {
          kind: 'BLOCKED',
          on: 'adapter built on fixtures; live sandbox call not yet made — see adapters/ksa/rate-publisher/README.md',
        },
        reference: 'rate-publisher port — benchmarks and market APRs',
      },
    ],
  },
  {
    id: 'uae-rails',
    jurisdictions: AE,
    icon: 'plug',
    titleEn: 'UAE integration rails',
    titleAr: 'قنوات التكامل الإماراتية',
    items: [
      {
        id: 'aecb',
        titleEn: 'AECB',
        titleAr: 'الاتحاد للمعلومات الائتمانية',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/aecb/README.md' },
        reference:
          'credit-bureau port — commercial and individual reports, facility reporting (ADR 0005); fetched from the assessment screen under the intake consent, answered by the labelled demonstration transport',
      },
      {
        id: 'uae-pass',
        titleEn: 'UAE Pass',
        titleAr: 'الهوية الرقمية (UAE Pass)',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/uae-pass/README.md' },
        reference: 'identity-authentication port — login, step-up, signing intent',
      },
      {
        id: 'icp',
        titleEn: 'ICP',
        titleAr: 'الهيئة الاتحادية للهوية والجنسية',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/icp/README.md' },
        reference: 'identity-verification port — Emirates ID attributes',
      },
      {
        id: 'ner',
        titleEn: 'NER',
        titleAr: 'السجل الاقتصادي الوطني',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/ner/README.md' },
        reference: 'business-registry port — trade licence status and owners',
      },
      {
        id: 'mohre',
        titleEn: 'MOHRE',
        titleAr: 'وزارة الموارد البشرية والتوطين',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/mohre/README.md' },
        reference: 'employment-verification port — WPS salary records',
      },
      {
        id: 'fta',
        titleEn: 'FTA',
        titleAr: 'الهيئة الاتحادية للضرائب',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/fta/README.md' },
        reference:
          'tax-compliance port — VAT registration status by TRN, checked at intake as information (never a KYB gap); labelled demonstration answers',
      },
      {
        id: 'partner-bank',
        titleEn: 'Partner bank',
        titleAr: 'البنك الشريك',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/partner-bank/README.md' },
        reference: 'payments port — disbursement and collection through the fund’s partner bank',
      },
      {
        id: 'uae-open-finance',
        titleEn: 'UAE Open Finance',
        titleAr: 'التمويل المفتوح في الإمارات',
        readiness: { kind: 'BLOCKED', on: 'fixture transport only — see adapters/uae/open-finance/README.md' },
        reference:
          'account-information port — affordability facts from CBUAE Open Finance v2.1; read on the loan application under the intake consent and confirmed by a second person; labelled demonstration answers',
      },
    ],
  },
  {
    // The Saudi SME journey, built milestone by milestone (K1–K4) on the UAE one. Each item says what works today.
    id: 'sme-direct-ksa',
    jurisdictions: SA,
    icon: 'building',
    titleEn: 'SME direct lending (Saudi Arabia)',
    titleAr: 'تمويل المنشآت المباشر (السعودية)',
    items: [
      {
        id: 'ksa-business-intake',
        titleEn: 'New application & intake',
        titleAr: 'طلب جديد واستلامه',
        href: '/business/intake/new',
        readiness: live(),
        reference:
          'K1: the same intake as the UAE journey with the commercial registration (CR) as the registration number — exempt, by field name, from the identity-number guard because a CR has a national id’s shape (REGISTRATION_FIELDS); beneficial owners against the cited 25% Saudi threshold (config/regulatory/sa/beneficial-ownership.json, articles to confirm)',
      },
      {
        id: 'ksa-business-kyb',
        titleEn: 'KYB checks (Wathq, Yakeen, screening, zakat)',
        titleAr: 'فحوصات اعرف عميلك (واثق ويقين والفحص والزكاة)',
        readiness: {
          kind: 'BLOCKED',
          on: 'fixture rails: Wathq, Yakeen, ZATCA (zakat certificate by CR), SIMAH and Open Banking run over the Saudi demonstration transport, labelled Fixture, only where a synthetic demonstration is permitted; elsewhere RAIL_UNAVAILABLE until each adapter in adapters/ksa has made a verified sandbox call',
        },
        reference:
          'Chosen by the tenant’s jurisdiction (intake-rails.ts); each check under the subject’s recorded consent; outcome and provider reference only',
      },
      {
        id: 'ksa-business-pipeline',
        titleEn: 'Business applications',
        titleAr: 'طلبات المنشآت',
        href: '/business',
        readiness: live(),
        reference:
          'The same pipeline and application screens as the UAE journey, in SAR. Bank A and Fintech B each open with an ILLUSTRATIVE development book of eight synthetic cases at every stage (spreading to disbursed, one in arrears), seeded only where a synthetic demonstration is permitted',
      },
      {
        id: 'ksa-business-policies',
        titleEn: 'Assessment, security, decision pack and offer',
        titleAr: 'التقييم والضمانات وحزمة القرار والعرض',
        href: '/business',
        readiness: live(),
        reference:
          'K2: each Saudi tenant’s own SME assessment, document checklist (sme-sa-term: CR, articles, national ids, SIMAH, zakat, GOSI…), security, decision-pack (adds zakat and GOSI covenants) and offer-date policies — every figure ILLUSTRATIVE, adapted from the UAE fund’s with SAR amounts; offers priced at SAIBOR-3M + the tenant’s margin from the rate publisher (demonstration transport, labelled Fixture, until adapters/ksa/rate-publisher is verified), the publisher’s reference kept on the offer; Hijri (Umm al-Qura) dates on the letter',
      },
      {
        id: 'ksa-business-closing',
        titleEn: 'Signing, disbursement and booking',
        titleAr: 'التوقيع والصرف والتسجيل',
        readiness: {
          kind: 'BLOCKED',
          on: 'fixture rails: signing runs the Nafath adapter (the signing intent carries the letter’s SHA-256) over the Saudi demonstration transport, labelled Fixture; each tranche is queued for the payments hub with the payee’s Saudi IBAN and the first with the SIMAH facility-opened report; booking runs the Tuum lending adapter on the demonstration transport — until adapters/ksa/nafath, adapters/ksa/payments-hub, adapters/ksa/simah and TUUM-LEND-01 are verified',
        },
        reference:
          'K3: the same closing as the UAE journey — conditions precedent, a payee IBAN (SA, 24 characters, mod 97) confirmed by a second person, tranches, the bank’s signed status report — with the Saudi rails; booked under the tenant’s mapping (SME FINANCE SAR RAG, ILLUSTRATIVE)',
      },
      {
        id: 'ksa-business-servicing',
        titleEn: 'Servicing: repayments and arrears',
        titleAr: 'خدمة التمويل: السداد والمتأخرات',
        href: '/business',
        readiness: live(),
        reference:
          'Servicing S1–S2: the same position, receipts and reconciliation as the UAE journey, in SAR; instalments presented as SADAD bills, the result a rail-confirmed receipt; the month’s status to SIMAH',
      },
      {
        id: 'ksa-business-islamic',
        titleEn: 'Islamic SME finance (Tawarruq)',
        titleAr: 'تمويل المنشآت الإسلامي (التورق)',
        readiness: {
          kind: 'BLOCKED',
          on: 'the institution’s Shariah board ruling for SME Tawarruq, recorded through Admin → Products (sme-term-islamic stays disabled without it), and the board’s view on booking it as a loan contract (ADR 0007); the commodity broker runs on the Saudi demonstration transport, labelled Fixture, until adapters/ksa/commodity-broker is verified',
        },
        reference:
          'K4 (built): offered as a deferred sale — commodity cost, profit, deferred price, the letter in profit terms with the customer as purchaser — then, between signature and disbursement, the commodity bought at exactly the quoted cost, sold to the customer on the signed instrument, title passed, sold on (as agent only where the board permits), each step validated by products/sme-term-islamic and attested after the one before; one payment of the proceeds, never tranches; booked as a loan contract (TAWRROUQ, ILLUSTRATIVE) under ADR 0007',
      },
    ],
  },
  {
    id: 'sme-direct-uae',
    jurisdictions: AE,
    icon: 'building',
    titleEn: 'SME direct lending (UAE)',
    titleAr: 'تمويل المنشآت المباشر (الإمارات)',
    items: [
      {
        id: 'business-intake',
        titleEn: 'New application & intake',
        titleAr: 'طلب جديد واستلامه',
        href: '/business/intake/new',
        readiness: live(),
        reference:
          'Stages 1–4 in Sanad (core/origination/business-intake.ts, 0025): trade licence and request keyed, parties by reference with ownership, consents into core.consent_record, beneficial owners against the cited 25% threshold (config/regulatory/ae/beneficial-ownership.json, article to confirm); hands over through the same stage-5 hand-over as the upstream API, idempotent on intake:<id>',
      },
      {
        id: 'business-kyb',
        titleEn: 'KYB checks (register, identity, screening)',
        titleAr: 'فحوصات اعرف عميلك (السجل والهوية والفحص)',
        readiness: {
          kind: 'BLOCKED',
          on: 'fixture rails: the NER and ICP adapters run over the demonstration transport and screening over a demonstration adapter, labelled Fixture, only where a synthetic demonstration is permitted; elsewhere RAIL_UNAVAILABLE until adapters/uae/ner, adapters/uae/icp and a screening vendor have made a verified sandbox call',
        },
        reference:
          'Each check under the subject’s recorded consent (the adapter verifies it, SR-026); outcome and provider reference only; REFER cleared by a checker other than the officer who opened the intake; REJECT declines',
      },
      {
        id: 'business-pipeline',
        titleEn: 'Business applications',
        titleAr: 'طلبات المنشآت',
        href: '/business',
        readiness: live(),
        reference:
          'Stages 5–9 (core/origination/business-application.ts) on core.business_application (0016); illustrative tenant sme-fund-ae with an ILLUSTRATIVE seed; stage targets from the partner prototype, ILLUSTRATIVE',
      },
      {
        id: 'business-assessment',
        titleEn: 'Credit assessment & scoring',
        titleAr: 'التقييم الائتماني والتقييم بالنقاط',
        href: '/business',
        readiness: live(),
        reference:
          'Verified figures under four eyes (read figures enter only through the system path — an uploaded PDF statement can be read by the document engine, its tables mapped under the tenant’s row labels, ILLUSTRATIVE; keyed figures and corrections are verified by a second principal), documents validated by the checker, variant checklists, SME assessment run by the checker (knock-outs, 40/60 scorecard, risk, STP vs committee) — every threshold ILLUSTRATIVE until the fund supplies its policy. The bureau result is fetched through the AECB rail under the intake consent (FIXTURE until that adapter is verified; nothing typed overrides it); a partner hand-over keys it from the upstream report, labelled keyed; bank-statement facts from Open Finance sit beside the spread, confirmed under four eyes; inputs lock at submission',
      },
      {
        id: 'business-security',
        titleEn: 'Collateral & guarantor register',
        titleAr: 'سجل الضمانات والكفلاء',
        href: '/business',
        readiness: live(),
        reference:
          'UAE M3 (core/origination/security-register.ts): collateral by kind, market value, valuation date and valuer, charge status with the registry reference; personal guarantees from the applicant’s owners and corporate guarantees, limited or unlimited; evidence named only if on the application. Recorded by the officer, confirmed by a different person; only confirmed, current items count. Lending value after the tenant’s haircut, cover rounded down, loan-to-value rounded up. The variant’s collateral codes map to requirements in config (credit-policy/security.json, ILLUSTRATIVE); submission refused while any is outstanding; scoring’s collateral cover comes from the register where it holds valued collateral. No charge-registry rail yet: references are keyed',
      },
      {
        id: 'business-decision-pack',
        titleEn: 'Decision pack (memo, deviations, conditions, covenants)',
        titleAr: 'حزمة القرار (المذكرة والاستثناءات والشروط والتعهدات)',
        href: '/business',
        readiness: live(),
        reference:
          'UAE M4 (core/origination/decision-pack.ts): a credit memo assembled from the record; deviations read from the assessment’s route reasons, each justified before a committee may approve, and never approved by the member who justified it; conditions precedent and subsequent in both languages and covenants from the tenant’s templates only (credit-policy/decision-pack.json, ILLUSTRATIVE), capped by the risk band’s maxConditions; locked once a committee member approves, frozen at approval by its SHA-256; stated in the offer letter. Satisfying conditions precedent before drawdown is M5',
      },
      {
        id: 'business-offer',
        titleEn: 'Offer letter & sending',
        titleAr: 'خطاب العرض وإرساله',
        href: '/business',
        readiness: live(),
        reference:
          'Offer quoted through sme-term-conventional on the dated ACT/365 schedule (dates within ILLUSTRATIVE bounds); bilingual letter hashed; one OFFER_ISSUED notification per letter version, on the outbox in the same transaction as the send',
      },
      {
        id: 'business-sign-disburse',
        titleEn: 'Signing & disbursement',
        titleAr: 'التوقيع والصرف',
        readiness: {
          kind: 'BLOCKED',
          on: 'fixture rails: signing runs the UAE Pass adapter over the demonstration transport, labelled Fixture, only where a synthetic demonstration is permitted; each tranche’s payment instruction (PAYMENT_DISBURSE with the payee IBAN; BUREAU_REPORT with the first) is queued on the outbox for the partner bank, and the bank’s status report arrives on a signed webhook (or, on the synthetic site only, is recorded as a Fixture) — until adapters/uae/uae-pass and adapters/uae/partner-bank have made a verified sandbox call',
        },
        reference:
          'UAE M5a: the signing intent opened on the sent letter version and bound to its SHA-256, confirmed by the identity service (signer recorded by reference); every condition precedent on the approved pack evidenced by a document and verified by a second person; the payee IBAN validated (country, length, mod 97), proven by a document and confirmed by a second person — the full IBAN shown only to an eligible confirmer; disbursement refused until all are met, released by a finance principal who is neither the approver, the submitter nor whoever recorded the payee. UAE M5b: a drawdown plan of 1–12 tranches adding up to the facility, released in order, each its own idempotent instruction; a rejected or returned payment fails the tranche and withdraws the payee confirmation until a second person confirms again (SR-050 fixed)',
      },
      {
        id: 'business-loan-booking',
        titleEn: 'Booking in the loan system',
        titleAr: 'التسجيل في نظام القروض',
        readiness: {
          kind: 'BLOCKED',
          on: 'fixture loan system: the Tuum lending adapter runs over the demonstration transport, labelled Fixture, until the fund’s AED product exists in Tuum and TUUM-LEND-01 is answered (adapters/tuum/README.md); live once the vault holds the CORE_BANKING credentials and person_api_base_url',
        },
        reference:
          'UAE M6 (core/ports/loan-booking.ts, adapters/tuum/lending-adapter.ts): a disbursed, rate-priced loan booked as a loan contract on the signed terms — Sanad’s rate and APR sent, never taken (a different echoed rate is refused) — idempotent on business:<id>:book; the loan account number, contract and customer references recorded once (LOAN_BOOKED). Product codes per tenant in config/tenants/<t>/core-banking/loan-products.json; Murabaha never booked this way',
        jurisdictions: AE,
      },
      {
        id: 'business-servicing',
        titleEn: 'Servicing: repayments and arrears',
        titleAr: 'خدمة التمويل: السداد والمتأخرات',
        href: '/business',
        readiness: live(),
        reference:
          'Servicing S1 (core/servicing/instalment-position.ts): the position of a disbursed facility against its signed schedule from confirmed receipts — oldest instalment first, charge before principal; due today is due, overdue the day after; arrears, days past due and bucket; stage 9 when past due, without a hand-keyed status. A manual receipt is recorded by finance and counts once a second person confirms it; the loan system’s report is reconciled against Sanad’s, a difference flagged. S2: instalments due within seven days or overdue are presented for collection — a SADAD bill in Saudi Arabia (BILL_PRESENT), a direct collection from the confirmed payee account through the partner bank in the UAE (PAYMENT_COLLECT) — each its own idempotent instruction; the channel’s signed result (webhooks/collection-results) becomes a rail-confirmed receipt, a returned one is presented again; the month’s status goes to the bureau once (ARREARS or INSTALMENT_PAID), SETTLED once when repaid in full. Channels on fixtures until SADAD and the partner bank are verified. S3: late charges once per instalment overdue beyond the grace days (a fee on a term loan, a charity obligation on an Islamic facility — never income), waived by a second person; a hardship hold pausing collections and charges, lifted by a second person; restructuring from today — a term loan re-amortised at its signed rate, an Islamic facility re-spread with its total unchanged — in force only once approved by a second person, the arrears folded into the new schedule. S4: the daily servicing cycle — late charges, collections and, from the reporting day, the month’s bureau status for every disbursed facility, recorded under the scheduler’s own principal, idempotent so a re-run changes nothing — as a Temporal workflow on each tenant’s Schedule (verified on a Temporal dev server 2026-10-17; the institution’s cluster still to come), and runnable now from the pipeline by finance. Every amount, limit and run time ILLUSTRATIVE (credit-policy/servicing.json). Both jurisdictions',
      },
      {
        id: 'business-handover-api',
        titleEn: 'Hand-over API',
        titleAr: 'واجهة تسليم الطلبات',
        readiness: live(),
        reference:
          'POST /api/origination/v1/business-applications — upstream customer-record credential (business:write), idempotent on upstreamRef',
      },
    ],
  },
  {
    id: 'counterparty',
    icon: 'people',
    titleEn: 'Counterparty',
    titleAr: 'العملاء',
    items: [
      { id: 'onboarding', titleEn: 'Onboarding', titleAr: 'التسجيل', readiness: soon(), reference: 'BR-B01' },
      {
        id: 'verification',
        titleEn: 'Verification exceptions',
        titleAr: 'استثناءات التحقق',
        readiness: soon(),
        reference: 'BR-B08',
      },
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
      {
        id: 'decisions',
        titleEn: 'Decisions & traces',
        titleAr: 'القرارات وسجلاتها',
        readiness: soon(),
        reference: 'BR-C03 — engine built, no screen',
      },
      {
        id: 'policy',
        titleEn: 'Credit policy',
        titleAr: 'سياسة الائتمان',
        readiness: soon(),
        reference: 'BR-C08 — versions in config/',
      },
      {
        id: 'facilities',
        titleEn: 'Facilities & limits',
        titleAr: 'التسهيلات والحدود',
        readiness: soon(),
        reference: 'SDD §6.7',
      },
      { id: 'concentration', titleEn: 'Concentration', titleAr: 'التركّز', readiness: soon(), reference: 'BR-C07' },
    ],
  },
  {
    id: 'transactions',
    // Murabaha SCF (Wasl) workstreams: drawdowns, sequencing gates, the financed-invoice registry.
    jurisdictions: SA,
    icon: 'exchange',
    titleEn: 'Transactions',
    titleAr: 'المعاملات',
    items: [
      {
        id: 'transaction-book',
        titleEn: 'Transaction book',
        titleAr: 'سجل المعاملات',
        href: '/transactions',
        readiness: live(),
        reference:
          'Wasl W1: approving a request opens its Murabaha transaction in DRAFT through the product module (board structure and positions, goods screened against the board’s register, profit amount from the catalogue), one per request, stored in core.transaction with its append-only event log; each transaction’s figures, structure, trade, gates and legs. Programmes, anchors and distributors ILLUSTRATIVE (config/tenants/bank-a/wasl/parties.json)',
      },
      { id: 'drawdowns', titleEn: 'Drawdowns', titleAr: 'عمليات السحب', readiness: soon(), reference: 'SDD §5.5.1' },
      {
        id: 'sequencing',
        titleEn: 'Sequencing & gates',
        titleAr: 'التسلسل والبوابات',
        href: '/transactions',
        readiness: live(),
        reference:
          'Wasl W2, on each transaction: trade validation (distinctness before purchase, SH-08) and the cost held against the programme’s limit (facility holds come with W5); the wa’d and the purchase as separate, hashed, attested, chained legs from the board-approved templates (SH-07, SH-17; the PDF rendition is not yet produced); gate 1 on the anchor’s invoice to the institution through the e-invoicing port (FIXTURE: the demonstration transport, KSA-RAIL-ZATCA-01); gate 2 on uploaded possession evidence a different person validates; gate 3, the risk-holding interval between attested instants (host-clock stand-in, SR-006); the sale offer, its lapse and an unwind with the goods’ disposition. Every step through the same activities as the Temporal workflow; legs, evidence and instants in core.contract_leg, evidence.evidence and core.transaction. W3: the distributor accepts in the SME portal — an authorised signatory (ILLUSTRATIVE, config/tenants/bank-a/wasl/parties.json) signed in through the national identity service and signing the offer instrument’s hash (FIXTURE: the Nafath demonstration transport), the assertion recorded on the acceptance. The steps and the book are shared by both surfaces (services/origination/src/wasl/)',
      },
      {
        id: 'evidence',
        titleEn: 'Evidence',
        titleAr: 'الأدلة',
        readiness: soon(),
        reference:
          'SDD §5.4.3 — recorded and validated per transaction since W2 (see Sequencing & gates); a cross-transaction evidence workspace for the board is W6',
      },
      {
        id: 'registry',
        titleEn: 'Financed invoice registry',
        titleAr: 'سجل الفواتير الممولة',
        readiness: soon(),
        reference: 'SH-10',
      },
      {
        id: 'matching',
        titleEn: 'Matching exceptions',
        titleAr: 'استثناءات المطابقة',
        readiness: soon(),
        reference: 'BR-D06',
      },
    ],
  },
  {
    id: 'documents',
    icon: 'document',
    titleEn: 'Documents',
    titleAr: 'المستندات',
    items: [
      {
        id: 'viewer',
        titleEn: 'Document viewer',
        titleAr: 'عارض المستندات',
        href: '/documents',
        readiness: live(),
        reference:
          'Web SDK on synthetic samples; evaluation mode until a licence key is saved — check V-01 in adapters/nutrient/verification/README.md',
      },
      {
        id: 'upload',
        titleEn: 'Document upload',
        titleAr: 'رفع المستندات',
        readiness: live(),
        reference:
          'Verified against Supabase Storage 2026-10-15 (STORAGE-01, adapters/storage/README.md); uses the tenant’s store once its S3_STORAGE credentials are saved, else the fixture store labelled Fixture where a synthetic demonstration is permitted, else refused. Business application checklist (UAE M2b): type read from the bytes (PDF, PNG, JPEG, 10 MB), stored by SHA-256 under tenant/application/hash, presented PENDING until a different person validates it, served back only to the tenant’s staff after the hash is checked',
        jurisdictions: AE,
      },
      {
        id: 'document-reading',
        titleEn: 'Document reading',
        titleAr: 'قراءة المستندات',
        readiness: live(),
        href: '/documents/reading',
        reference:
          'Document intelligence D1 (docs/DOCUMENT-INTELLIGENCE-PLAN.md): each uploaded business document is read — the kind recognised from its text against the tenant’s catalogue (config/tenants/<t>/documents/document-types.json, ILLUSTRATIVE), its issue, expiry and statement dates, and whether it matches the type presented — and shown to the checker beside it. Findings in evidence.document_finding, append-only; dates and outcomes only, never a number from the page. An aid, never a decision: four eyes always (product owner, 2026-10-19). Engine: rules over the institution’s document engine (LIVE once configured; V-05/V-06 for Saudi samples), else the demonstration reader labelled Fixture; an AI engine plugs in behind the same port later. Images are not read yet. D2: the checks each checklist item declares (expiry, issue recency, statement period and coverage, registration number and business name compared and only the outcome kept; ILLUSTRATIVE limits), shown PASS / FAIL with what was seen / UNREADABLE — never counted by the checklist. Corroboration with Wathq and GOSI waits on their live verification. D3: authenticity with the issuer (Tahaqoq, Saudi) under the intake’s document-verification consent; a document the issuer does not confirm is accepted only with the checker’s written resolution, kept on the event. D4: the gaps (missing, expired, refused, wrong document, not confirmed, failing a check) in words the applicant can act on; one INFORMATION_REQUESTED notification per gap set on the outbox; the case shows ready again when the last gap closes. D5: the throughput view (/documents/reading) — first-attempt naming against the checker, checks by type, how often the checker accepted despite a failed check, touchpoints and time to a complete pack; measurement only',
      },
      {
        id: 'templates',
        titleEn: 'Templates & versions',
        titleAr: 'القوالب والإصدارات',
        readiness: soon(),
        reference: 'BR-G02',
      },
      {
        id: 'generated',
        titleEn: 'Generated documents',
        titleAr: 'المستندات الصادرة',
        readiness: {
          kind: 'BLOCKED',
          on: 'Document Engine runs locally in Nutrient’s evaluation mode (adapters/nutrient/compose; V-02 and V-03 passed 2026-10-17, and HTML-to-PDF renders Arabic joined and right-to-left; the Facility Offer Letter renders as a stored PDF from the offer page); the production licence and the in-Kingdom deployment are still to come, and evaluation output carries a watermark.',
        },
        reference: 'OI-05',
      },
      {
        id: 'signature',
        titleEn: 'Signature & seal',
        titleAr: 'التوقيع والختم',
        readiness: {
          kind: 'BLOCKED',
          on: 'OI-06 — no validated long-term-validation signed document exists yet. The path works: the signed offer letter is sealed through Document Engine and the development signing service, and validates at PAdES B-B (V-04 plumbing, 2026-10-17); the licensed provider’s certificate, timestamp and revocation services are still to come.',
        },
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
      {
        id: 'instructions',
        titleEn: 'Instructions',
        titleAr: 'أوامر التسوية',
        href: '/transactions',
        readiness: live(),
        reference:
          'Wasl W4a, on each transaction: the purchase instructs the cost to the anchor’s settlement account through the payments hub, on the transactional outbox, idempotently; results by signed webhook (PAYMENTS_HUB secret); a rejected or returned payment instructed again by finance under a new key. Instalments presented to SADAD as bills from seven days before they fall due (BILL_COLLECTION). FIXTURE: the KSA demonstration transport and result stand-ins (KSA-RAIL-PAYHUB-01, KSA-RAIL-SADAD-01); anchor IBANs ILLUSTRATIVE',
      },
      {
        id: 'reconciliation',
        titleEn: 'Reconciliation',
        titleAr: 'المطابقة',
        readiness: soon(),
        reference: 'SDD §6.10 — W4b: SADAD’s paid-bills file matched against Wasl presentations',
      },
      {
        id: 'returns',
        titleEn: 'Returns',
        titleAr: 'المرتجعات',
        href: '/transactions',
        readiness: live(),
        reference:
          'Wasl W4a: a returned collection takes its receipt off the obligation (the total never moves) and frees the instalment to be presented again; a return after settlement is refused for operations to resolve; a returned seller payment is instructed again by finance',
      },
    ],
  },
  {
    id: 'lifecycle',
    icon: 'cycle',
    titleEn: 'Lifecycle',
    titleAr: 'دورة الحياة',
    items: [
      {
        id: 'obligations',
        titleEn: 'Obligations & schedules',
        titleAr: 'الالتزامات والجداول',
        href: '/transactions',
        readiness: live(),
        reference:
          'Wasl W3: an accepted sale is booked — the obligation and its schedule (the product’s own split, dated from the stored maturity, both calendars) in core.obligation and core.instalment, where the total is fixed and the schedule sums to it (SH-02); the receivable in the core banking platform account-shaped, never as a loan contract (ADR 0007), idempotently; FIXTURE: the Tuum demonstration transport until the tenant’s posting codes are read (TUUM-ACCT-01). A booking the core did not take is retried from the transaction. Collections and reschedule on Wasl obligations are W4 and later',
      },
      { id: 'reschedule', titleEn: 'Reschedule', titleAr: 'إعادة الجدولة', readiness: soon(), reference: 'BR-E02' },
      {
        id: 'hardship',
        titleEn: 'Hardship',
        titleAr: 'التعثّر والإعسار',
        readiness: soon(),
        reference: 'SH-14 · BR-E05',
      },
      {
        id: 'embedded-collection',
        titleEn: 'Embedded collection',
        titleAr: 'التحصيل المدمج',
        readiness: soon(),
        reference:
          'Embedded lending module — revenue-linked collection where the tenant policy permits it; OI-23 remains open for Islamic tenants only (ADR 0002)',
      },
    ],
  },
  {
    id: 'shariah',
    icon: 'shield-check',
    titleEn: 'Shariah governance',
    titleAr: 'الحوكمة الشرعية',
    items: [
      {
        id: 'approvals',
        titleEn: 'Approvals register',
        titleAr: 'سجل الاعتمادات',
        readiness: soon(),
        reference: 'BR-F01 · SH-17',
      },
      {
        id: 'audit',
        titleEn: 'Audit workspace',
        titleAr: 'مساحة التدقيق الشرعي',
        readiness: soon(),
        reference: 'BR-F05 · SH-18',
      },
      { id: 'incidents', titleEn: 'Incidents', titleAr: 'المخالفات', readiness: soon(), reference: 'BR-F04' },
      {
        id: 'purification',
        titleEn: 'Charity ledger & purification',
        titleAr: 'سجل الخير والتطهير',
        readiness: soon(),
        reference: 'SH-13 · BR-F06 — domain built',
      },
    ],
  },
  {
    id: 'programmes',
    // Murabaha SCF (Wasl) workstreams: anchors, programmes, goods, commodity brokers.
    jurisdictions: SA,
    icon: 'building',
    titleEn: 'Programmes',
    titleAr: 'البرامج',
    items: [
      { id: 'anchors', titleEn: 'Anchors', titleAr: 'الشركات الراعية', readiness: soon(), reference: 'BR-A01' },
      {
        id: 'programmes',
        titleEn: 'Programmes & limits',
        titleAr: 'البرامج والحدود',
        readiness: soon(),
        reference: 'BR-A02',
      },
      { id: 'goods', titleEn: 'Goods register', titleAr: 'سجل البضائع', readiness: soon(), reference: 'SH-11' },
      {
        id: 'commodity',
        titleEn: 'Commodity brokers',
        titleAr: 'وسطاء السلع',
        readiness: soon(),
        reference:
          'Tawarruq module — commodity broker port; enabled per tenant by its board ruling (ADR 0002 reverses PR-X2)',
      },
    ],
  },
  {
    id: 'administration',
    icon: 'settings',
    titleEn: 'Administration',
    titleAr: 'الإدارة',
    items: [
      {
        id: 'staff-sign-in',
        titleEn: 'Staff sign-in (SSO)',
        titleAr: 'دخول الموظفين (الدخول الموحد)',
        href: '/sign-in',
        readiness: {
          kind: 'BLOCKED',
          on: 'OIDC staff sign-in is built for the workbench and Admin (authorization code + PKCE, state and nonce in a sealed single-use cookie, discovery, JWKS with rotation, ID token validation; tenant sealed before the redirect; authorities only from that tenant’s group mappings; step-up before approvals) and tested against a local key pair with no network. It stays BLOCKED until a live call to a real provider (the first: IOTA’s identity provider) has been verified with the demo tenants’ placeholders filled in. SAML is not built. Development per-person staff tokens are unchanged and refused when NODE_ENV=production',
        },
        reference:
          'SDD §4.7 · SEC-TM08/12/14 · ASVS V2/V3 — packages/auth/oidc.ts, packages/auth/staff-oidc.ts, config/tenants/*/identity/staff-identity.json',
      },
      {
        id: 'users',
        titleEn: 'Users & entitlements',
        titleAr: 'المستخدمون والصلاحيات',
        readiness: soon(),
        reference: 'SDD §4.7 — catalogue built',
      },
      {
        id: 'licensing',
        titleEn: 'Installation licence',
        titleAr: 'ترخيص النظام',
        // Built: signed-licence verification, the state and the one gate at every new-business entry point,
        // Admin → Licence under four eyes, the request file, a fixture-only check-in. Not yet able to license a
        // production installation, for the two reasons below — so not LIVE.
        readiness: {
          kind: 'BLOCKED',
          on: 'the issuer’s production public key is added to core/licensing/keys.ts at provisioning (until then a production build verifies no licence and starts no new business); the issuer’s check-in server does not exist yet, so online check-in has a fixture transport only',
        },
        reference: 'ADR 0006 · core/licensing · migration 0017 · Admin → Licence',
      },
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
