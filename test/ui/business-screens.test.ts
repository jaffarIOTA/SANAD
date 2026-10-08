/**
 * The UAE SME pipeline screens: what they say and how they lay it out.
 *
 * Each block pins one defect a review found on the screens, so that it
 * cannot come back quietly:
 *
 *   - the stage strip let English titles cross their cards' borders;
 *   - numeric column headers sat at the start while their figures sat at the
 *     end (two alignments on one element);
 *   - Arabic screens showed Latin digits, Latin decimal points and '%';
 *   - raw enum codes (VERY_LOW, STRAIGHT_THROUGH) reached the screen;
 *   - identifiers inside Arabic text were not isolated, and 'UAE Pass' broke
 *     across lines with mirrored parentheses in the sidebar;
 *   - the variant note named a vendor and was English on the Arabic screen;
 *   - a UAE deployment's sidebar listed the Saudi products and rails, and no
 *     item was highlighted under /business;
 *   - the ratio equations used a '÷' that reads as '+';
 *   - the Arabic offer screen led with the English email;
 *   - the offer screen claimed a PDF that does not exist and did not show the
 *     stored rate and APR;
 *   - the refusal panel rendered whatever a `?message=` parameter said.
 *
 * The words and the logic live in plain TypeScript (server/business-dashboard.ts,
 * [locale]/navigation.ts) and are tested directly. The pages themselves are
 * `.tsx` under apps/ops, whose tsconfig preserves JSX for Next.js, so Vitest
 * cannot import them; their markup is asserted by reading the source — the
 * same technique as test/ui/logical-properties.test.ts — and was checked in
 * a browser at 1440 in both directions.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { STAGE_OF } from '@sanad/core/origination/business-application.ts';

import {
  type BusinessApplicationView,
  listApplications,
  previewNotifications,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import {
  ARABIC_SUMMARY_MARKER,
  LETTER_ACTION,
  REFUSALS,
  ROUTE_LABELS,
  SEND_LABEL,
  STATUS_WORDS,
  VARIANT_NOTE,
  arabicDigits,
  codeWords,
  formatFact,
  humanise,
  refusalFromQuery,
  refusalText,
  riskLevelWords,
  splitOfferEmail,
} from '../../apps/ops/src/server/business-dashboard.ts';
import { MODULE_GROUPS } from '../../apps/ops/src/server/modules.ts';
import { activeItemId, latinSuffix, navigationFor, tallyOf } from '../../apps/ops/src/app/[locale]/navigation.ts';
import { source as repoSource } from './source.ts';

const LATIN_DIGIT = /[0-9]/;
const ARABIC_LETTER = /[\u0600-\u06FF]/;
const source = (path: string): string => repoSource(`apps/ops/src/app/[locale]/${path}`);

const UI = source('business/ui.tsx');
const APPLICATION = source('business/[applicationId]/page.tsx');
const ASSESSMENT = source('business/[applicationId]/assessment/page.tsx');
const OFFER = source('business/[applicationId]/offer/page.tsx');
const LIST = source('business/page.tsx');
const DASHBOARD = source('PipelineDashboard.tsx');
const PAGES = { APPLICATION, ASSESSMENT, OFFER, LIST, DASHBOARD } as const;

/** The seed's application with a sent offer, walked through the real state machine in memory. */
let offered: BusinessApplicationView | undefined;
beforeAll(async () => {
  resetBusinessStore();
  offered = (await listApplications('sme-fund-ae')).find((v) => v.application.applicationId === 'FR-00005106');
});

// -- 1. The stage strip --------------------------------------------------------

describe('the stage strip', () => {
  const stepper = UI.slice(UI.indexOf('export function StageStepper'), UI.indexOf('// -- The application shell'));

  it('scrolls inside its own relative box instead of letting a card overflow', () => {
    expect(stepper).toContain('<div className="relative overflow-x-auto');
  });

  it('gives each card a minimum width and clips at the card, and lets a long title wrap inside it', () => {
    expect(stepper).toMatch(/<li [^>]*w-\[112px\][^>]*overflow-hidden/);
    expect(stepper).toContain('wrap-anywhere');
    // Number above the title, so the title has the card's whole width.
    expect(stepper).toMatch(/<li [^>]*flex-col/);
  });
});

// -- 2. Numeric headers ----------------------------------------------------------

describe('numeric column headers', () => {
  it('have their own end-aligned class with no competing start alignment', () => {
    const th = /const TH_BASE = '([^']*)'/.exec(UI)?.[1] ?? '';
    expect(th).not.toMatch(/text-(start|end)/);
    expect(UI).toContain('export const TH_END = `${TH_BASE} text-end`;');
  });

  it.each(Object.entries(PAGES))('%s never puts text-end on top of TH', (_name, src) => {
    expect(src).not.toMatch(/\$\{TH\}[^`]*text-end/);
  });

  it('end-aligns the offer schedule’s amount headers', () => {
    for (const label of ['Principal', 'Interest', 'Instalment', 'Opening', 'Closing']) {
      expect(OFFER).toMatch(new RegExp(`className=\\{(TH_END|\`\\$\\{TH_END\\}[^\`]*\`)\\}>\\{t\\('${label}'`));
    }
  });
});

// -- 3. Arabic numerals ----------------------------------------------------------

describe('Arabic numerals', () => {
  it('turns a quantity’s digits, decimal point, thousands comma and percent sign into the Arabic forms', () => {
    expect(arabicDigits('1.40×')).toBe('١٫٤٠×');
    expect(arabicDigits('50.00%')).toBe('٥٠٫٠٠٪');
    expect(arabicDigits('2%')).toBe('٢٪');
    expect(arabicDigits('10,000')).toBe('١٠٬٠٠٠');
    expect(arabicDigits('650')).toBe('٦٥٠');
    expect(arabicDigits('92.50 / 100')).toBe('٩٢٫٥٠ / ١٠٠');
  });

  it('leaves a sentence’s full stop alone', () => {
    expect(arabicDigits('اليوم 5.')).toBe('اليوم ٥.');
  });

  it('renders every knock-out threshold kind in the policy with no Latin digit', () => {
    for (const [fact, value] of [
      ['bureauScore', 650n],
      ['dscrPerTenThousand', 14_000n],
      ['currentRatioPerTenThousand', 13_000n],
      ['salesGrowthPerTenThousand', 200n],
      ['ownerDbrPerTenThousand', 5_000n],
      ['riskAnalysisScorePerTenThousand', 7_400n],
    ] as const) {
      expect(arabicDigits(formatFact(fact, value, true)), fact).not.toMatch(LATIN_DIGIT);
    }
  });

  it('writes no Latin quantity into an Arabic string on the pages', () => {
    // The second argument of t(en, ar) is the Arabic. A Latin digit there is a quantity in the wrong numerals
    // (identifiers go through <Id>, not into the string).
    const arabicArgs = /t\(\s*(?:'[^']*'|`[^`]*`)\s*,\s*(?:'([^']*)'|`([^`]*)`)\s*\)/g;
    const offenders: string[] = [];
    for (const [name, src] of Object.entries({ ...PAGES, UI })) {
      for (const m of src.matchAll(arabicArgs)) {
        const ar = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '');
        if (LATIN_DIGIT.test(ar) && !/^[\s/·×%()-]*$/.test(ar)) offenders.push(`${name}: ${ar.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// -- 4. No raw codes ---------------------------------------------------------------

describe('no raw codes on screen', () => {
  it('has bilingual words for every application status', () => {
    for (const status of Object.keys(STAGE_OF)) {
      const l = STATUS_WORDS[status];
      expect(l, status).toBeDefined();
      expect(l?.ar, status).toMatch(ARABIC_LETTER);
    }
  });

  it('has bilingual words for every route', () => {
    for (const route of ['STRAIGHT_THROUGH', 'COMMITTEE', 'REFER', 'DECLINE'])
      expect(ROUTE_LABELS[route]?.ar, route).toMatch(ARABIC_LETTER);
  });

  it('words every risk level, preferring the policy’s own band label', () => {
    for (const level of ['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH']) {
      expect(riskLevelWords(level, true)).toMatch(ARABIC_LETTER);
      expect(riskLevelWords(level, false)).not.toContain('_');
    }
    expect(riskLevelWords('LOW', false, [{ level: 'LOW', label: { en: 'Band B', ar: 'الفئة ب' } }])).toBe('Band B');
  });

  it('never returns a code for an unmapped value', () => {
    expect(humanise('VERY_LOW')).toBe('Very low');
    expect(codeWords({}, 'SOMETHING_NEW', false)).toBe('Something new');
    expect(codeWords({}, 'SOMETHING_NEW', true)).toMatch(ARABIC_LETTER);
  });

  it('maps the risk levels in the straight-through condition line and does not print the risk level code under the tile', () => {
    expect(ASSESSMENT).not.toContain("c.required.replace(/\\|/g, ' · ')");
    expect(ASSESSMENT).toMatch(/RISK_LEVEL_ALLOWED' \? c\.required\.split\('\|'\)[^\n]*map\(riskWords\)/);
    expect(ASSESSMENT).not.toContain('sub={run.assessment.riskLevel ??');
  });
});

// -- 5. Bidi -------------------------------------------------------------------------

describe('identifiers inside text', () => {
  it('isolates every identifier left to right through one component', () => {
    expect(UI).toContain('return (<bdi dir="ltr" className={`identifier ${className ?? \'\'}`}>{children}</bdi>);');
  });

  it('puts the checklist version, the policy version and the principals through it', () => {
    expect(APPLICATION).toContain('<Id>{checklist.value.checklist.version}</Id>');
    expect(ASSESSMENT).toContain('<Id>{run.assessment.policyVersion}</Id>');
    expect(ASSESSMENT).toContain('<Id>{run.assessedBy}</Id>');
    for (const [name, src] of Object.entries(PAGES)) expect(src, name).not.toMatch(/\(\$\{BUSINESS_ROLES\.\w+\}\)/);
  });

  it('keeps a Latin product name in an Arabic sidebar label on one line, with its own parentheses', () => {
    expect(latinSuffix('الهوية الرقمية (UAE Pass)')).toEqual({ before: 'الهوية الرقمية', latin: '(UAE Pass)' });
    expect(latinSuffix('Murabaha SCF (Wasl)')).toBeUndefined();
    expect(latinSuffix('التمويل الشخصي (تورّق)')).toBeUndefined();
  });
});

// -- 6. The variant note -------------------------------------------------------------

describe('the variant note', () => {
  it('names no vendor and is Arabic on the Arabic screen', () => {
    expect(VARIANT_NOTE.en).not.toMatch(/tuum/i);
    expect(VARIANT_NOTE.ar).toMatch(ARABIC_LETTER);
    expect(VARIANT_NOTE.ar).not.toMatch(/[A-Za-z]/);
  });

  it('is what the page renders, never the catalogue’s note text', () => {
    expect(APPLICATION).not.toContain('{variant.note}');
    expect(APPLICATION).toContain('variantProvenanceNote(f)');
  });
});

// -- 7. The sidebar, by jurisdiction ----------------------------------------------------

describe('the sidebar, by jurisdiction', () => {
  const ids = (groups: ReturnType<typeof navigationFor>) => ({
    groups: groups.map((g) => g.id),
    items: groups.flatMap((g) => g.items.map((i) => i.id)),
  });

  it('lists no Saudi product or rail in a UAE deployment, and lists the UAE ones', () => {
    const ae = ids(navigationFor('AE'));
    for (const saudi of ['murabaha-scf', 'tawarruq-personal', 'bnpl', 'merchants', 'nafath', 'simah'])
      expect(ae.items).not.toContain(saudi);
    expect(ae.groups).not.toContain('rails');
    expect(ae.groups).toEqual(
      expect.arrayContaining(['uae-rails', 'sme-direct-uae', 'origination', 'products', 'documents', 'administration']),
    );
    expect(ae.items).toContain('business-pipeline');
  });

  it('lists no UAE rail or UAE SME item in a Saudi deployment', () => {
    const sa = ids(navigationFor('SA'));
    expect(sa.groups).not.toContain('uae-rails');
    expect(sa.groups).not.toContain('sme-direct-uae');
    expect(sa.items).toEqual(expect.arrayContaining(['murabaha-scf', 'bnpl', 'nafath', 'simah']));
  });

  it('loses nothing: every module is listed in one jurisdiction or the other', () => {
    const both = new Set([...ids(navigationFor('AE')).items, ...ids(navigationFor('SA')).items]);
    expect(both).toEqual(new Set(MODULE_GROUPS.flatMap((g) => g.items.map((i) => i.id))));
  });

  it('counts readiness over what it lists', () => {
    const ae = navigationFor('AE');
    expect(Object.values(tallyOf(ae)).reduce((s, n) => s + n, 0)).toBe(ae.flatMap((g) => g.items).length);
  });

  it('highlights the business applications item on every /business screen, and the dashboard only at the root', () => {
    const ae = navigationFor('AE');
    expect(activeItemId(ae, 'en', '/en/business')).toBe('business-pipeline');
    expect(activeItemId(ae, 'ar', '/ar/business/FR-00005106/offer')).toBe('business-pipeline');
    expect(activeItemId(ae, 'en', '/en')).toBe('dashboard');
    expect(activeItemId(ae, 'en', '/en/products')).toBe('catalogue');
    expect(activeItemId(ae, 'en', '/en/businessx')).toBeUndefined();
  });

  it('is told the jurisdiction by the layout and reads the path itself', () => {
    const layout = source('layout.tsx');
    expect(layout).toContain('<SideNav segment={segment} arabic={arabic} jurisdiction={jurisdiction.code} />');
    expect(source('SideNav.tsx')).toMatch(/^'use client';/);
    expect(source('SideNav.tsx')).toContain('usePathname()');
  });
});

// -- 8. Ratio equations ---------------------------------------------------------------

describe('ratio equations', () => {
  it('write the division in words at body size, never as a small ÷', () => {
    for (const [name, src] of Object.entries({ APPLICATION, ASSESSMENT })) {
      expect(src, name).not.toContain('<span aria-hidden>÷</span>');
      expect(src, name).toContain('<DividedBy f={f} />');
    }
    expect(UI).toContain("f.t('divided by', 'مقسوماً على')");
  });
});

// -- 9. The offer notification, Arabic first --------------------------------------------

describe('the offer notification preview', () => {
  it('splits the email the service builds at its Arabic summary', async () => {
    expect(offered).toBeDefined();
    const notices = await previewNotifications('sme-fund-ae', 'FR-00005106');
    expect(notices.ok).toBe(true);
    const body = notices.ok ? (notices.value.email?.body ?? '') : '';
    expect(body).toContain(ARABIC_SUMMARY_MARKER);
    const parts = splitOfferEmail(body);
    expect(parts.arabic).toMatch(/^السادة/);
    expect(parts.english).toMatch(/^Dear /);
    expect(parts.english).not.toContain(ARABIC_SUMMARY_MARKER);
    expect(splitOfferEmail('no marker')).toEqual({ english: 'no marker' });
  });

  it('puts the SMS first and the Arabic summary before the English body on an Arabic screen', () => {
    const grid = OFFER.slice(OFFER.indexOf("t('Preview notification'"), OFFER.indexOf("t('Preview offer letter'"));
    expect(grid.indexOf('{f.arabic ? <SmsPreview')).toBeLessThan(grid.indexOf('<EmailPreview'));
    const email = OFFER.slice(OFFER.indexOf('function EmailPreview'), OFFER.indexOf('function ActionItem'));
    expect(email).toMatch(/f\.arabic && arabic !== null \? \(\s*<>\s*\{arabic\}/);
  });

  it('labels the letter’s version line in both languages and isolates the hash', () => {
    expect(OFFER).toMatch(
      /data-letter-version[\s\S]{0,400}<Id className="break-all text-ink">\{letter\.version\}<\/Id>/,
    );
  });
});

// -- 10. No PDF that does not exist; rate and APR shown --------------------------------

describe('the offer’s send action and figures', () => {
  it('sends by email and SMS and names the letter by reference', () => {
    expect(SEND_LABEL.en).toBe('Confirm & Send — Email + SMS');
    expect(SEND_LABEL.ar).not.toContain('PDF');
    expect(LETTER_ACTION.title).toEqual({ en: 'Offer letter (by reference)', ar: 'خطاب العرض (بالمرجع)' });
    expect(LETTER_ACTION.body.en).toContain('when the document platform is licensed');
    expect(OFFER).not.toContain('Offer letter PDF');
    expect(OFFER).not.toContain('+ PDF');
  });

  it('shows the stored rate and the platform’s APR through <Rate>, from the offer terms', () => {
    expect(OFFER).toContain("import { Rate } from '@sanad/design/Rate.tsx';");
    expect(OFFER).toContain("<Rate rate={rate(terms.rateBp, 'REDUCING', 'ANNUAL')}");
    expect(OFFER).toContain("<Rate rate={rate(terms.aprBp, 'APR', 'ANNUAL')}");
  });

  it('has a rate and an APR on the seeded sent offer to show', () => {
    const terms = offered?.latestOffer?.terms;
    expect(typeof terms?.rateBp).toBe('bigint');
    expect(typeof terms?.aprBp).toBe('bigint');
    expect((terms?.aprBp ?? 0n) >= (terms?.rateBp ?? 0n)).toBe(true);
  });
});

// -- 12. The refusal panel ----------------------------------------------------------------

describe('the refusal panel', () => {
  it('words a refusal from its reason code and never from a message parameter', () => {
    const crafted = {
      control: 'OP-DETERMINACY',
      reason: 'FIGURES_NOT_VERIFIED',
      message: 'Call 800-FAKE to unlock your loan',
    };
    const shown = refusalFromQuery(crafted, false);
    expect(shown?.explanation).toBe(REFUSALS['FIGURES_NOT_VERIFIED']?.en);
    expect(shown?.explanation).not.toContain('800-FAKE');
    expect(refusalText('FIGURES_NOT_VERIFIED', true)).toBe(REFUSALS['FIGURES_NOT_VERIFIED']?.ar);
  });

  it('shows nothing for a control that is not shaped like one, and a generic line for an unknown reason', () => {
    expect(refusalFromQuery({ control: 'Your account is locked' }, false)).toBeUndefined();
    const unknown = refusalFromQuery({ control: 'OP-DETERMINACY', reason: 'not a code' }, true);
    expect(unknown?.control).toBe('OP-DETERMINACY');
    expect(unknown?.explanation).toMatch(ARABIC_LETTER);
  });

  it('is not given the message parameter by any page', () => {
    for (const [name, src] of Object.entries({ ...PAGES, UI }))
      expect(src, name).not.toMatch(/query\.message|readonly message\?/);
  });
});
