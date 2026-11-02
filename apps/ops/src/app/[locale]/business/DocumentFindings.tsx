/**
 * What the document engine read from an uploaded document, beside it, for the
 * checker (document intelligence D1): the kind of document it recognised,
 * whether that is a kind the document may be presented as, and the dates it
 * declares. An aid only — the checker still decides, and is never the person
 * who presented it. A reading from the demonstration reader says so.
 */
import type { ReactElement } from 'react';

import type { CheckResult, CivilDate, Fact } from '@sanad/core/documents/understanding.ts';
import type { StoredFindings } from '@sanad/origination/documents/findings.ts';

import { SourceBadge } from './intake/IntakeUi.tsx';
import { Chip, type Formatters } from './ui.tsx';

const KIND: Readonly<Record<string, readonly [string, string]>> = {
  COMMERCIAL_REGISTRATION: ['Commercial registration', 'سجل تجاري'],
  NATIONAL_ID: ['National ID', 'هوية وطنية'],
  NATIONAL_ADDRESS: ['National address', 'عنوان وطني'],
  BANK_STATEMENT: ['Bank statement', 'كشف حساب بنكي'],
  VAT_CERTIFICATE: ['VAT certificate', 'شهادة ضريبة القيمة المضافة'],
  ZAKAT_CERTIFICATE: ['Zakat certificate', 'شهادة الزكاة'],
  GOSI_CERTIFICATE: ['GOSI certificate', 'شهادة التأمينات الاجتماعية'],
  ARTICLES_OF_ASSOCIATION: ['Articles of association', 'عقد التأسيس'],
  CHAMBER_MEMBERSHIP: ['Chamber membership', 'عضوية الغرفة التجارية'],
  AUDITED_FINANCIALS: ['Audited financial statements', 'قوائم مالية مدققة'],
  CREDIT_BUREAU_REPORT: ['Credit bureau report', 'تقرير ائتماني'],
  TRADE_LICENCE: ['Trade licence', 'رخصة تجارية'],
  EMIRATES_ID: ['Emirates ID', 'الهوية الإماراتية'],
  SALARY_CERTIFICATE: ['Salary certificate', 'شهادة راتب'],
  WPS_SALARY_REPORT: ['WPS salary report', 'تقرير نظام حماية الأجور'],
  TENANCY_CONTRACT: ['Tenancy contract', 'عقد إيجار'],
};

const kindLabel = (kind: string, f: Formatters): string => {
  const k = KIND[kind];
  return k === undefined ? kind.toLowerCase().replaceAll('_', ' ') : f.t(k[0], k[1]);
};

const dateLabel = (d: CivilDate, f: Formatters): string =>
  d.calendar === 'HIJRI' ? `${f.digits(d.date)} ${f.t('AH', 'هـ')}` : f.isoDate(d.date);

/** The dates shown; the registration number is compared, never kept or shown. */
const FACT: Readonly<Record<Exclude<Fact['fact'], 'REGISTRATION_NUMBER'>, readonly [string, string]>> = {
  ISSUE_DATE: ['Issued', 'صدر'],
  EXPIRY_DATE: ['Expires', 'ينتهي'],
  STATEMENT_PERIOD: ['Period', 'الفترة'],
};

/**
 * One declared check (D2) in words, both languages: what passed, or what was
 * seen and the limit it was held to. A check that could not be made says so
 * and asks for the eye — it is never shown as a failure.
 */
function observedLabel(c: CheckResult, f: Formatters): string {
  if (c.observed === undefined) return '';
  const [from, to] = c.observed.split('..');
  const one = (d: string) => dateLabel({ calendar: c.calendar ?? 'GREGORIAN', date: d }, f);
  return to === undefined ? one(c.observed) : `${one(from ?? '')} – ${one(to)}`;
}

const CHECK_TONE = { PASS: 'good', FAIL: 'bad', UNREADABLE: 'neutral' } as const;

function checkLabel(c: CheckResult, f: Formatters): string {
  const n = f.n(Number.parseInt(c.limit ?? '0', 10));
  const seen = observedLabel(c, f);
  const pass = c.outcome === 'PASS';
  switch (c.check) {
    case 'NOT_EXPIRED':
      return pass
        ? f.t('Not expired', 'غير منتهي')
        : c.limit === undefined
          ? f.t(`Expired: ${seen}`, `منتهي: ${seen}`)
          : f.t(`Expires ${seen}, less than ${n} days left`, `ينتهي ${seen}، وبقي أقل من ${n} يومًا`);
    case 'ISSUED_WITHIN':
      return pass
        ? f.t(`Issued within ${n} days`, `صدر خلال ${n} يومًا`)
        : f.t(`Issued ${seen}: older than ${n} days`, `صدر ${seen}: أقدم من ${n} يومًا`);
    case 'PERIOD_ENDS_WITHIN':
      return pass
        ? f.t(`Statement ends within ${n} days`, `ينتهي الكشف خلال ${n} يومًا`)
        : f.t(`Statement ends ${seen}: more than ${n} days ago`, `ينتهي الكشف ${seen}: قبل أكثر من ${n} يومًا`);
    case 'PERIOD_COVERS':
      return pass
        ? f.t(`Covers ${n} months`, `يغطي ${n} شهرًا`)
        : f.t(`Covers less than ${n} months (${seen})`, `يغطي أقل من ${n} شهرًا (${seen})`);
    case 'REGISTRATION_MATCHES':
      return pass
        ? f.t('Registration number matches the application', 'رقم السجل يطابق الطلب')
        : f.t("Registration number differs from the application's", 'رقم السجل يختلف عن الطلب');
    case 'NAME_FOUND':
      return f.t('Business name found', 'اسم المنشأة موجود');
    case 'AUTHENTIC':
      return pass
        ? f.t('The issuer confirms it is authentic', 'أكدت الجهة المصدرة صحته')
        : f.t(
            'The issuer does not confirm it: resolve before accepting',
            'لم تؤكد الجهة المصدرة صحته: عالِج ذلك قبل القبول',
          );
    default:
      return c.check.toLowerCase().replaceAll('_', ' ');
  }
}

const CHECK_NAME: Readonly<Record<string, readonly [string, string]>> = {
  NOT_EXPIRED: ['Expiry', 'الانتهاء'],
  ISSUED_WITHIN: ['Issue date', 'تاريخ الإصدار'],
  PERIOD_ENDS_WITHIN: ['Statement end', 'نهاية الكشف'],
  PERIOD_COVERS: ['Statement period', 'فترة الكشف'],
  REGISTRATION_MATCHES: ['Registration number', 'رقم السجل'],
  NAME_FOUND: ['Business name', 'اسم المنشأة'],
};

/** Why the issuer was not asked (D3): said plainly, never as a pass or a failure. */
const NOT_CHECKED: Readonly<Record<string, readonly [string, string]>> = {
  NO_CONSENT: [
    'Authenticity not checked: the business gave no consent for it at intake',
    'لم يُتحقق من الصحة: لم تمنح المنشأة موافقة على ذلك عند الاستقبال',
  ],
  RAIL_UNAVAILABLE: [
    'Authenticity not checked: the issuer’s service is not connected here',
    'لم يُتحقق من الصحة: خدمة الجهة المصدرة غير متصلة هنا',
  ],
  TYPE_NOT_COVERED: [
    'Authenticity not checked: the issuer’s service does not cover this document',
    'لم يُتحقق من الصحة: خدمة الجهة المصدرة لا تشمل هذا المستند',
  ],
  REFUSED: [
    'Authenticity not checked: the issuer’s service declined the request',
    'لم يُتحقق من الصحة: رفضت خدمة الجهة المصدرة الطلب',
  ],
};

const unreadableLabel = (c: CheckResult, f: Formatters): string => {
  if (c.check === 'AUTHENTIC') {
    const why = NOT_CHECKED[c.reason ?? 'RAIL_UNAVAILABLE'] ?? NOT_CHECKED['RAIL_UNAVAILABLE'];
    return why === undefined ? c.check : f.t(why[0], why[1]);
  }
  const k = CHECK_NAME[c.check];
  const name = k === undefined ? c.check : f.t(k[0], k[1]);
  return f.t(`${name}: not read, check by eye`, `${name}: لم يُقرأ، تحقّق بالنظر`);
};

function unreadText(c: StoredFindings['classification'], f: Formatters): string {
  if (c.status === 'UNREADABLE' && c.reason === 'MEDIA_NOT_READ')
    return f.t('Not read: images are not read yet', 'لم يُقرأ: الصور لا تُقرأ بعد');
  if (c.status === 'UNREADABLE' && c.reason === 'NOT_READ')
    return f.t('Not read: no document engine here', 'لم يُقرأ: لا يوجد محرك مستندات هنا');
  return f.t('Not recognised: check it by eye', 'لم يُتعرّف عليه: تحقّق منه بالنظر');
}

export function DocumentFindings({
  findings,
  f,
}: {
  readonly findings: StoredFindings | undefined;
  readonly f: Formatters;
}): ReactElement | null {
  if (findings === undefined) return null;
  const c = findings.classification;
  const typeCheck = findings.checks.find((k) => k.check === 'TYPE_MATCHES_DECLARED');
  const read =
    c.status === 'RECOGNISED'
      ? f.t(
          `Reads as: ${kindLabel(c.kind, f)} (${f.n(Math.floor(c.confidencePerTenThousand / 100))}%)`,
          `يُقرأ على أنه: ${kindLabel(c.kind, f)} (${f.n(Math.floor(c.confidencePerTenThousand / 100))}٪)`,
        )
      : c.status === 'AMBIGUOUS'
        ? f.t(
            `Could be: ${c.candidates.map((k) => kindLabel(k, f)).join(' / ')}`,
            `قد يكون: ${c.candidates.map((k) => kindLabel(k, f)).join(' / ')}`,
          )
        : unreadText(c, f);
  const tone = typeCheck?.outcome === 'PASS' ? 'good' : typeCheck?.outcome === 'FAIL' ? 'bad' : 'neutral';
  const verdict =
    typeCheck?.outcome === 'PASS'
      ? f.t('matches the type presented', 'يطابق النوع المقدَّم')
      : typeCheck?.outcome === 'FAIL'
        ? f.t('does not match the type presented', 'لا يطابق النوع المقدَّم')
        : undefined;
  const facts = findings.facts.filter((x) => x.status === 'READ');
  const content = findings.checks.filter((k) => k.check !== 'TYPE_MATCHES_DECLARED');

  return (
    <span className="flex flex-wrap items-center gap-2 text-[12px]" data-document-findings>
      <Chip tone={tone}>
        {read}
        {verdict === undefined ? '' : ` — ${verdict}`}
      </Chip>
      {facts.map((x) => (
        <span key={x.fact} className="text-ink-quiet">
          {f.t(FACT[x.fact][0], FACT[x.fact][1])}{' '}
          <bdi>
            {x.status === 'READ' && x.fact === 'STATEMENT_PERIOD'
              ? `${dateLabel(x.from, f)} – ${dateLabel(x.to, f)}`
              : x.status === 'READ' && x.fact !== 'STATEMENT_PERIOD'
                ? dateLabel(x.value, f)
                : ''}
          </bdi>
        </span>
      ))}
      {findings.source === 'FIXTURE' ? <SourceBadge source="FIXTURE" f={f} /> : null}
      {content.length === 0 ? null : (
        <span className="flex w-full flex-wrap gap-2" data-document-checks>
          {content.map((k) => (
            <span key={k.check} data-check={k.check} data-outcome={k.outcome}>
              <Chip tone={CHECK_TONE[k.outcome]}>
                {k.outcome === 'UNREADABLE' ? unreadableLabel(k, f) : checkLabel(k, f)}
              </Chip>
              {/* A rail's answer carries its own reference and whether it was a fixture (D3). */}
              {k.reference === undefined ? null : (
                <bdi dir="ltr" className="identifier ms-1 text-[11px] text-ink-quiet">
                  {k.reference}
                </bdi>
              )}
              {k.source === 'FIXTURE' && findings.source !== 'FIXTURE' ? <SourceBadge source="FIXTURE" f={f} /> : null}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
