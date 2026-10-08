/**
 * The SME screens after the second verification pass. Each block pins one
 * finding so it cannot come back quietly:
 *
 *   1. the stage-5 journey was blocked on screen: there was no checker control
 *      for a PENDING document, the assessment-inputs form posted no
 *      bureauConsentId, the inputs form stayed open after submission (where
 *      the service refuses it), the run did not say the checker runs it, the
 *      offer screen said the checker releases disbursement (the finance
 *      principal does), and nothing offered a new letter version after a send;
 *   2. refusals the service and the actions return had no words, and three
 *      notices had none;
 *   3. STALE_APPLICATION had no Arabic in the problem catalogue and was not
 *      listed on the hand-over's 409;
 *   4. the sidebar filtered by hard-coded ids instead of a tag on the module.
 *
 * Pages are `.tsx` under apps/ops (JSX preserved for Next.js), so their markup
 * is asserted by reading the source, as in business-screens.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { problem } from '@sanad/origination/problem.ts';

import { NOTICES, REFUSALS } from '../../apps/ops/src/server/business-dashboard.ts';
import { MODULE_GROUPS, type ModuleGroup } from '../../apps/ops/src/server/modules.ts';
import { navigationFor } from '../../apps/ops/src/app/[locale]/navigation.ts';

const ARABIC_LETTER = /[؀-ۿ]/;
const LATIN_DIGIT = /[0-9]/;
const repo = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const page = (path: string): string => repo(`apps/ops/src/app/[locale]/${path}`);

const APPLICATION = page('business/[applicationId]/page.tsx');
const ASSESSMENT = page('business/[applicationId]/assessment/page.tsx');
const OFFER = page('business/[applicationId]/offer/page.tsx');
const ACTIONS = repo('apps/ops/src/server/business-actions.ts');

/** The body of one exported action in business-actions.ts. */
const actionBody = (name: string): string => {
  const start = ACTIONS.indexOf(`export async function ${name}(`);
  const next = ACTIONS.indexOf('export async function', start + 1);
  return ACTIONS.slice(start, next < 0 ? undefined : next);
};
/** The form fields an action reads: field(form, 'x'). */
const fieldsRead = (name: string): string[] =>
  [...actionBody(name).matchAll(/field\(form, '([A-Za-z]+)'\)/g)].map((m) => m[1] ?? '');

// -- 1. The stage-5 journey ---------------------------------------------------------

describe('a presented document can be validated on screen', () => {
  const form = APPLICATION.slice(
    APPLICATION.indexOf('<form action={validateDocumentAction}'),
    APPLICATION.indexOf('</form>', APPLICATION.indexOf('<form action={validateDocumentAction}')),
  );

  it('has a checker control posting validateDocumentAction for a PENDING document', () => {
    expect(APPLICATION).toContain("r.status === 'PENDING' && held !== undefined ? (");
    expect(form).toContain('<FormContext segment={segment} applicationId={a.applicationId} />');
  });

  it('posts exactly the fields the action reads, with VALID and INVALID', () => {
    const fields = fieldsRead('validateDocumentAction');
    expect(fields).toEqual(expect.arrayContaining(['decision', 'documentRef']));
    expect(form).toContain('name="documentRef" value={held.documentRef}');
    expect(form).toContain('name="decision" value="VALID"');
    expect(form).toContain('name="decision" value="INVALID"');
    expect(form).toContain('{BUSINESS_ROLES.checker}');
  });

  it('shows each document’s status and who presented and validated it', () => {
    expect(APPLICATION).toContain('<DocumentProvenance held={held} f={f} />');
    expect(APPLICATION).toContain('<Id>{held.presentedBy}</Id>');
    expect(APPLICATION).toContain('<Id>{held.validatedBy}</Id>');
    expect(APPLICATION).toMatch(/PENDING: \{ en: 'Awaiting the checker'/);
  });

  it('does not offer to attach a document that is already awaiting the checker', () => {
    expect(APPLICATION).toContain("open && r.status !== 'PRESENT' && r.status !== 'PENDING' ? (");
  });

  it('carries no hidden sourceKind input the action ignores', () => {
    expect(APPLICATION).not.toContain('name="sourceKind"');
    expect(fieldsRead('proposeFigureAction')).not.toContain('sourceKind');
    expect(fieldsRead('verifyFigureAction')).not.toContain('sourceKind');
  });
});

describe('the assessment inputs', () => {
  it('post every field the action reads, the bureau consent included', () => {
    const form = ASSESSMENT.slice(
      ASSESSMENT.indexOf('<form action={recordAssessmentInputsAction}'),
      ASSESSMENT.indexOf('</form>', ASSESSMENT.indexOf('<form action={recordAssessmentInputsAction}')),
    );
    for (const name of fieldsRead('recordAssessmentInputsAction')) {
      if (name === 'locale' || name === 'applicationId' || name === 'screen' || name === 'tenant') continue;
      expect(form, name).toMatch(new RegExp(`(name=["']${name}["']|field\\('${name}')`));
    }
    expect(form).toContain('name="bureauConsentId"');
    // The consent is chosen from the stage-4 references: the service accepts no other.
    expect(form).toContain('consentRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)');
  });

  it('are editable only while the application is open, and read-only once it is submitted or later', () => {
    expect(ASSESSMENT).toContain("const inputsOpen = ['RECEIVED', 'SPREADING'].includes(a.status);");
    expect(ASSESSMENT).toContain(
      '{inputsOpen || inputs !== undefined ? <InputsCard segment={segment} applicationId={a.applicationId} view={view} editable={inputsOpen} f={f} /> : null}',
    );
    expect(ASSESSMENT).toContain('{!editable ? null : (');
    expect(ASSESSMENT).toContain('data-inputs-read-only');
    expect(ASSESSMENT).toContain('<Id className="text-[12px]">{inputs.bureau.consentId}</Id>');
  });

  it('are required on screen before Submit, since they lock at submission', () => {
    expect(APPLICATION).toContain('const inputsMissing = view.assessmentInputs === undefined;');
    expect(APPLICATION).toMatch(/const ready = [^\n]*&& !inputsMissing;/);
  });
});

describe('who acts', () => {
  it('names the checker as the one who runs the assessment', () => {
    const run = ASSESSMENT.slice(
      ASSESSMENT.indexOf('data-runs-assessment'),
      ASSESSMENT.indexOf('<form action={runAssessmentAction}>'),
    );
    expect(run).toContain('<Id>{BUSINESS_ROLES.checker}</Id>');
    expect(actionBody('runAssessmentAction')).toContain('BUSINESS_ROLES.checker');
  });

  it('has the finance principal, not the checker, release disbursement', () => {
    expect(actionBody('recordDisbursedAction')).toContain('BUSINESS_ROLES.finance');
    const signed = OFFER.slice(OFFER.indexOf("case 'SIGNED':"), OFFER.indexOf("case 'DISBURSED':"));
    expect(signed).toContain('<Id>{BUSINESS_ROLES.finance}</Id>');
    expect(signed).not.toContain('BUSINESS_ROLES.checker');
    expect(signed).not.toMatch(/The checker|المراجِع/);
    const flow = OFFER.slice(OFFER.indexOf('التسلسل'), OFFER.indexOf('</SectionCard>', OFFER.indexOf('التسلسل')));
    expect(flow).toContain('BUSINESS_ROLES.finance');
    expect(flow).not.toContain('BUSINESS_ROLES.checker');
  });
});

describe('after a letter is sent', () => {
  const sent = OFFER.slice(OFFER.indexOf("case 'OFFER_SENT':"), OFFER.indexOf("case 'SIGNED':"));

  it('offers to generate a new version (a resend needs one), with dates to change', () => {
    expect(sent).toContain('<form action={generateOfferAction}');
    expect(sent).toContain("t('Generate a new version', 'إعداد إصدار جديد')");
    expect(sent).toContain('name="disbursementDate"');
  });

  it('offers to send a newer, unsent version, and keeps recording the signature on the sent one', () => {
    expect(sent).toContain('const unsent = latestVersion !== undefined && latestVersion !== letterVersion;');
    expect(sent).toContain('<form action={sendOfferAction}');
    expect(sent).toContain('<form action={recordSignedAction}');
    expect(sent).toContain('name="letterVersion" value={letterVersion ?? \'\'}');
  });
});

// -- 2. Refusal and notice wording -----------------------------------------------------

/**
 * Every reason code the business service, its actions, the business state
 * machine and the financial spread can return, read from their source:
 * fail('X'), bad('X'), refused('X'), and reject('CONTROL', 'X').
 */
function reasonsIn(path: string): string[] {
  const src = repo(path);
  const found = new Set<string>();
  for (const m of src.matchAll(/\b(?:fail|bad|refused|reject)\(\s*(?:'[A-Z][A-Z-]+',\s*)?'([A-Z][A-Z0-9_]+)'/g))
    found.add(m[1] ?? '');
  return [...found];
}

const SOURCES = [
  'apps/ops/src/server/business.ts',
  'apps/ops/src/server/business-actions.ts',
  'core/origination/business-application.ts',
  'core/applicant/financials.ts',
] as const;

describe('refusal wording', () => {
  it('finds the reasons it checks (the scan is not vacuous)', () => {
    const all = SOURCES.flatMap(reasonsIn);
    expect(all.length).toBeGreaterThan(60);
    expect(all).toEqual(
      expect.arrayContaining([
        'STALE_APPLICATION',
        'FOUR_EYES_SELF_ASSESSMENT',
        'FOUR_EYES_DISBURSEMENT',
        'TRANSITION_NOT_ALLOWED',
        'AMOUNT_MALFORMED',
      ]),
    );
  });

  it.each(SOURCES)('has bilingual words for every reason %s can return', (path) => {
    const missing = reasonsIn(path).filter((r) => REFUSALS[r] === undefined);
    expect(missing).toEqual([]);
    for (const r of reasonsIn(path)) {
      expect(REFUSALS[r]?.ar, r).toMatch(ARABIC_LETTER);
      expect(REFUSALS[r]?.ar, r).not.toMatch(LATIN_DIGIT);
      expect(REFUSALS[r]?.en, r).not.toMatch(ARABIC_LETTER);
    }
  });

  it('covers the reasons the verification pass named', () => {
    for (const r of [
      'STALE_APPLICATION',
      'FOUR_EYES_REQUIRED',
      'FOUR_EYES_SELF_ASSESSMENT',
      'FOUR_EYES_SELF_APPROVAL',
      'FOUR_EYES_DISBURSEMENT',
      'ASSESSMENT_INPUTS_LOCKED',
      'BUREAU_CONSENT_MISSING',
      'BUREAU_CONSENT_NOT_ON_RECORD',
      'DOCUMENT_NOT_FOUND',
      'DOCUMENT_ALREADY_VALIDATED',
      'FIGURE_ALREADY_VERIFIED',
      'OFFER_DATE_MALFORMED',
      'DISBURSEMENT_BEFORE_OFFER',
      'DISBURSEMENT_TOO_FAR',
      'FIRST_DUE_TOO_SOON',
      'FIRST_DUE_TOO_LATE',
    ]) {
      expect(REFUSALS[r], r).toBeDefined();
    }
  });

  it('has words for every notice an action redirects with', () => {
    // finish(ctx, result, 'NOTICE') — or a ternary between two notices as that third argument.
    const direct = [...ACTIONS.matchAll(/\breturn finish\(ctx, [^\n]*, '([A-Z][A-Z_]+)'\);/g)].map((m) => m[1] ?? '');
    const ternaries = [...ACTIONS.matchAll(/\? '([A-Z][A-Z_]+)' : '([A-Z][A-Z_]+)'\);/g)].flatMap((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ]);
    const all = new Set([...direct, ...ternaries]);
    expect(all.size).toBeGreaterThan(12);
    for (const n of ['FIGURE_CORRECTED', 'DOCUMENT_VALIDATED', 'DOCUMENT_REJECTED']) expect(all.has(n), n).toBe(true);
    for (const n of all) {
      expect(NOTICES[n], n).toBeDefined();
      expect(NOTICES[n]?.ar, n).toMatch(ARABIC_LETTER);
    }
  });

  it('is rendered from the maps only: no page query type carries a message', () => {
    for (const [name, src] of Object.entries({ APPLICATION, ASSESSMENT, OFFER })) {
      expect(src, name).toMatch(
        /type Query = \{ readonly notice\?: string; readonly control\?: string; readonly reason\?: string; readonly tenant\?: string \};/,
      );
      expect(src, name).not.toMatch(/message/);
    }
  });
});

// -- 3. STALE_APPLICATION on the wire ----------------------------------------------------

describe('STALE_APPLICATION on the hand-over API', () => {
  it('has Arabic in the problem catalogue, not the generic line', () => {
    const p = problem({
      status: 409,
      kind: 'conflict',
      title: 'Conflict',
      detail: 'x',
      reason: 'STALE_APPLICATION',
      control: 'OP-DETERMINACY',
      correlationId: 'c-1',
    });
    expect(p.detailAr).toMatch(ARABIC_LETTER);
    expect(p.detailAr).not.toContain('OP-DETERMINACY');
    expect(p.detailAr).toContain('أعد التحميل');
  });

  it('is listed on the hand-over’s 409 in the OpenAPI source and in the generated API Connect artefact', () => {
    const spec = repo('api/openapi/origination.v1.yaml');
    const handover = spec.slice(
      spec.indexOf('operationId: handOverBusinessApplication'),
      spec.indexOf('/business-applications/{applicationId}:'),
    );
    expect(handover).toContain("'409': { $ref: '#/components/responses/HandoverConflict' }");
    const conflict = spec.slice(spec.indexOf('    HandoverConflict:'), spec.indexOf('    IdempotencyConflict:'));
    for (const r of ['STALE_APPLICATION', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_KEY_IN_FLIGHT'])
      expect(conflict).toContain(r);
    const apic = repo('gateway/ibm/origination-api_1.0.0.yaml');
    expect(apic).toContain('HandoverConflict');
    expect(apic).toContain('STALE_APPLICATION');
  });
});

// -- 4. The sidebar by tag ----------------------------------------------------------------

describe('the sidebar filters by the module’s own jurisdiction tag', () => {
  it('names no group or item id in navigation.ts', () => {
    const nav = page('navigation.ts');
    for (const id of ['murabaha-scf', 'bnpl', 'uae-rails', 'sme-direct-uae', 'programmes', 'transactions'])
      expect(nav, id).not.toContain(`'${id}'`);
    expect(nav).not.toMatch(/GROUP_JURISDICTION|ITEM_JURISDICTION/);
  });

  it('tags every Saudi-only and UAE-only entry in the module map', () => {
    const group = (id: string) => MODULE_GROUPS.find((g) => g.id === id);
    const item = (id: string) => MODULE_GROUPS.flatMap((g) => g.items).find((i) => i.id === id);
    for (const id of ['rails', 'programmes', 'transactions']) expect(group(id)?.jurisdictions, id).toEqual(['SA']);
    for (const id of ['uae-rails', 'sme-direct-uae']) expect(group(id)?.jurisdictions, id).toEqual(['AE']);
    for (const id of [
      'murabaha-scf',
      'tawarruq-personal',
      'bnpl',
      'merchants',
      'embedded-lending',
      'conventional-term',
      'embedded',
    ])
      expect(item(id)?.jurisdictions, id).toEqual(['SA']);
    // Platform-wide entries carry no tag.
    for (const id of ['origination', 'products', 'documents', 'administration'])
      expect(group(id)?.jurisdictions, id).toBeUndefined();
  });

  it('follows a tag on a module it has never seen', () => {
    const groups: readonly ModuleGroup[] = [
      {
        id: 'g-any',
        titleEn: 'Any',
        titleAr: 'أي',
        icon: 'plug',
        items: [
          { id: 'i-any', titleEn: 'Any', titleAr: 'أي', readiness: { kind: 'NOT_BUILT' }, reference: 'test' },
          {
            id: 'i-ae',
            titleEn: 'AE',
            titleAr: 'إ',
            readiness: { kind: 'NOT_BUILT' },
            reference: 'test',
            jurisdictions: ['AE'],
          },
          {
            id: 'i-both',
            titleEn: 'Both',
            titleAr: 'كلاهما',
            readiness: { kind: 'NOT_BUILT' },
            reference: 'test',
            jurisdictions: ['AE', 'SA'],
          },
        ],
      },
      {
        id: 'g-sa',
        titleEn: 'SA',
        titleAr: 'س',
        icon: 'plug',
        jurisdictions: ['SA'],
        items: [{ id: 'i-sa', titleEn: 'SA', titleAr: 'س', readiness: { kind: 'NOT_BUILT' }, reference: 'test' }],
      },
    ];
    const ids = (code: 'SA' | 'AE') => navigationFor(code, groups).flatMap((g) => g.items.map((i) => i.id));
    expect(ids('AE')).toEqual(['i-any', 'i-ae', 'i-both']);
    expect(ids('SA')).toEqual(['i-any', 'i-both', 'i-sa']);
  });
});
