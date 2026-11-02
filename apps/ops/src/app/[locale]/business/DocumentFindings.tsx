/**
 * What the document engine read from an uploaded document, beside it, for the
 * checker (document intelligence D1): the kind of document it recognised,
 * whether that is a kind the document may be presented as, and the dates it
 * declares. An aid only — the checker still decides, and is never the person
 * who presented it. A reading from the demonstration reader says so.
 */
import type { ReactElement } from 'react';

import type { CivilDate, Fact } from '@sanad/core/documents/understanding.ts';
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

const FACT: Readonly<Record<Fact['fact'], readonly [string, string]>> = {
  ISSUE_DATE: ['Issued', 'صدر'],
  EXPIRY_DATE: ['Expires', 'ينتهي'],
  STATEMENT_PERIOD: ['Period', 'الفترة'],
};

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
        : c.status === 'UNREADABLE' && c.reason === 'MEDIA_NOT_READ'
          ? f.t('Not read: images are not read yet', 'لم يُقرأ: الصور لا تُقرأ بعد')
          : f.t('Not recognised: check it by eye', 'لم يُتعرّف عليه: تحقّق منه بالنظر');
  const tone = typeCheck?.outcome === 'PASS' ? 'good' : typeCheck?.outcome === 'FAIL' ? 'bad' : 'neutral';
  const verdict =
    typeCheck?.outcome === 'PASS'
      ? f.t('matches the type presented', 'يطابق النوع المقدَّم')
      : typeCheck?.outcome === 'FAIL'
        ? f.t('does not match the type presented', 'لا يطابق النوع المقدَّم')
        : undefined;
  const facts = findings.facts.filter((x) => x.status === 'READ');

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
    </span>
  );
}
