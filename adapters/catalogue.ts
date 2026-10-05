/**
 * The adapter catalogue: which adapter codes may serve each capability.
 *
 * The engine consumes capabilities and never names a vendor; this file is
 * where the vendor names are allowed to appear, so a tenant's rail
 * configuration can be checked against what is actually built. A code listed
 * here is an adapter directory under adapters/; readiness (fixtures only, or
 * live) is the module registry's business, not this list's.
 */

import type { AdapterCatalogue } from '../core/config/rails.ts';

export const ADAPTER_CATALOGUE: AdapterCatalogue = {
  CORE_BANKING: ['TUUM'],
  DOCUMENT_PLATFORM: ['NUTRIENT'],
  E_INVOICING: ['ZATCA'],
  TAX_COMPLIANCE: ['ZATCA'],
  IDENTITY: ['NAFATH'],
  IDENTITY_AUTHENTICATION: ['NAFATH'],
  IDENTITY_VERIFICATION: ['YAKEEN'],
  DOCUMENT_VERIFICATION: ['TAHAQOQ'],
  BUSINESS_REGISTRY: ['WATHQ'],
  CREDIT_BUREAU: ['SIMAH', 'BAYAN'],
  EMPLOYMENT_VERIFICATION: ['GOSI'],
  OPEN_BANKING: ['OPEN_BANKING'],
  BILL_COLLECTION: ['SADAD'],
  PAYMENTS_HUB: ['PAYMENTS_HUB'],
  RATE_PUBLISHER: ['RATE_PUBLISHER'],
  COMMODITY_BROKER: ['COMMODITY_BROKER'],
  SCREENING: ['SCREENING'],
  CERTIFICATION_SERVICE_PROVIDER: ['CSP'],
  TIMESTAMP_AUTHORITY: ['TSA'],
  WORKFLOW_ENGINE: ['WORKFLOW_ENGINE'],
};

/** Bilingual labels for the admin surface. Capability names, the vendor codes speak for themselves. */
export const CAPABILITY_LABELS: Readonly<Record<keyof typeof ADAPTER_CATALOGUE, { readonly en: string; readonly ar: string }>> = {
  CORE_BANKING: { en: 'Core banking', ar: 'النظام المصرفي الأساسي' },
  DOCUMENT_PLATFORM: { en: 'Document platform', ar: 'منصة المستندات' },
  E_INVOICING: { en: 'E-invoicing clearance', ar: 'الفوترة الإلكترونية' },
  TAX_COMPLIANCE: { en: 'Zakat and tax status', ar: 'الزكاة والضريبة' },
  IDENTITY: { en: 'Identity (legacy)', ar: 'الهوية (قديم)' },
  IDENTITY_AUTHENTICATION: { en: 'Identity authentication', ar: 'مصادقة الهوية' },
  IDENTITY_VERIFICATION: { en: 'Identity verification', ar: 'التحقق من الهوية' },
  DOCUMENT_VERIFICATION: { en: 'Document verification', ar: 'التحقق من المستندات' },
  BUSINESS_REGISTRY: { en: 'Business registry', ar: 'السجل التجاري' },
  CREDIT_BUREAU: { en: 'Credit bureau', ar: 'المعلومات الائتمانية' },
  EMPLOYMENT_VERIFICATION: { en: 'Employment verification', ar: 'التحقق من التوظيف' },
  OPEN_BANKING: { en: 'Open banking', ar: 'المصرفية المفتوحة' },
  BILL_COLLECTION: { en: 'Bill collection', ar: 'تحصيل الفواتير' },
  PAYMENTS_HUB: { en: 'Payments hub', ar: 'مركز المدفوعات' },
  RATE_PUBLISHER: { en: 'Rate publisher', ar: 'ناشر الأسعار' },
  COMMODITY_BROKER: { en: 'Commodity broker', ar: 'وسيط السلع' },
  SCREENING: { en: 'Screening', ar: 'الفحص' },
  CERTIFICATION_SERVICE_PROVIDER: { en: 'Certification service provider', ar: 'مقدّم خدمات التصديق' },
  TIMESTAMP_AUTHORITY: { en: 'Timestamping authority', ar: 'هيئة الختم الزمني' },
  WORKFLOW_ENGINE: { en: 'Workflow engine', ar: 'محرك سير العمل' },
};
