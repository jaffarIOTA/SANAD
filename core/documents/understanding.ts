/**
 * Document understanding (document intelligence D1): what an uploaded
 * document is, and the dates on it that matter, read from its text.
 *
 * The result is a set of **findings** the checker sees beside the document.
 * A finding informs; it never decides: every document is still validated by a
 * person other than the one who presented it (product owner, 2026-10-19), and
 * a failed check is never a refusal on its own.
 *
 * Snapshots, not copies (CLAUDE.md §5): what is kept is the classification,
 * the dates read and the outcome of each check — never a name, an identity
 * number or an address read off the page. Those stay inside the document, in
 * the object store.
 *
 * Everything that varies by institution or document is configuration
 * (`DocumentTypeCatalogue`): which types exist, the markers that recognise
 * them in English and Arabic, and the labelled dates to read. The reading
 * itself is pure and deterministic, so a finding can be reproduced from the
 * same text and the same catalogue version — which is what lets a second
 * engine (an AI model, later) be compared with this one on the same documents.
 *
 * No clock is read; nothing here constructs a date from the system.
 */
import { type Result, ok, reject } from '../kernel/result.ts';
import type { DocumentExtractionPort, ExtractedContent } from '../ports/document-extraction.ts';
import { type CheckContext, type DocumentCheckRule, evaluateChecks } from './document-checks.ts';
import type { RailOutcome } from '../ports/rail.ts';

// -- The catalogue (tenant configuration) ----------------------------------------------

/**
 * What may be read after a label. REGISTRATION_NUMBER is compared with the
 * application's at reading time and only the outcome is kept (D2): the number
 * itself never leaves the reading.
 */
export type FactName = 'ISSUE_DATE' | 'EXPIRY_DATE' | 'STATEMENT_PERIOD' | 'REGISTRATION_NUMBER';

export interface FactDefinition {
  readonly fact: FactName;
  /** Labels the date follows, in either script. The first that appears with a readable date is taken. */
  readonly labels: readonly string[];
}

/**
 * A kind of document as it can be told apart by its text (a bank statement,
 * a commercial registration), and the checklist types it can stand for. A
 * checklist may ask for finer types than text distinguishes — a 12-month and
 * a 6-month statement read alike; the period is a check (D2), not a kind.
 */
export interface DocumentTypeDefinition {
  readonly kind: string;
  /** The checklist document types a document of this kind may be presented as. */
  readonly satisfies: readonly string[];
  /** Text that marks this kind, each with a weight. A marker counts once, however often it appears. */
  readonly markers: readonly { readonly text: string; readonly weight: number }[];
  /** The least score at which the type is recognised at all. */
  readonly minimumScore: number;
  /** The score at which recognition is certain (10 000 per ten thousand); scores in between scale. */
  readonly confidentScore: number;
  readonly facts: readonly FactDefinition[];
}

export interface DocumentTypeCatalogue {
  readonly catalogueVersion: string;
  /** Which engine reads this tenant's documents. Rules over the document engine's text, for now. */
  readonly engine: 'RULES';
  /** Two types within this score of each other are ambiguous: neither is claimed. */
  readonly ambiguityMargin: number;
  readonly types: readonly DocumentTypeDefinition[];
}

const FACTS: readonly FactName[] = ['ISSUE_DATE', 'EXPIRY_DATE', 'STATEMENT_PERIOD', 'REGISTRATION_NUMBER'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Parse a tenant's document-type catalogue. Anything malformed is refused whole, never half-applied. */
export function parseDocumentTypeCatalogue(raw: unknown): Result<DocumentTypeCatalogue> {
  const bad = (detail: string) => reject('OP-DETERMINACY', 'DOCUMENT_TYPES_INVALID', detail);
  if (!isRecord(raw)) return bad('The document-type catalogue is an object');
  if (typeof raw['catalogueVersion'] !== 'string' || raw['catalogueVersion'].length === 0)
    return bad('The catalogue names its version');
  // An AI engine is a second adapter, selected here once its hosting is approved; until then only RULES is accepted.
  if (raw['engine'] !== 'RULES') return bad('The engine is RULES');
  if (!positiveInt(raw['ambiguityMargin'])) return bad('ambiguityMargin is a positive integer');
  const types: DocumentTypeDefinition[] = [];
  const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
  for (const t of Array.isArray(raw['types']) ? raw['types'] : []) {
    if (!isRecord(t) || typeof t['kind'] !== 'string' || !CODE.test(t['kind']))
      return bad('Each type names its kind in upper case');
    const satisfies = Array.isArray(t['satisfies']) ? t['satisfies'] : [];
    if (satisfies.length === 0 || !satisfies.every((s) => typeof s === 'string' && CODE.test(s)))
      return bad(`${t['kind']}: satisfies names the checklist document types it stands for`);
    const markers = Array.isArray(t['markers']) ? t['markers'] : [];
    if (
      markers.length === 0 ||
      !markers.every(
        (m) => isRecord(m) && typeof m['text'] === 'string' && m['text'].trim() !== '' && positiveInt(m['weight']),
      )
    )
      return bad(`${t['kind']}: markers are text with a positive weight`);
    if (!positiveInt(t['minimumScore']) || !positiveInt(t['confidentScore']) || t['confidentScore'] < t['minimumScore'])
      return bad(`${t['kind']}: minimumScore ≤ confidentScore, both positive`);
    const facts = Array.isArray(t['facts']) ? t['facts'] : [];
    if (
      !facts.every(
        (f) =>
          isRecord(f) &&
          FACTS.includes(f['fact'] as FactName) &&
          Array.isArray(f['labels']) &&
          f['labels'].length > 0 &&
          f['labels'].every((l) => typeof l === 'string' && l.trim() !== ''),
      )
    )
      return bad(`${t['kind']}: each fact names a known fact and its labels`);
    types.push({
      kind: t['kind'],
      satisfies: satisfies.map(String),
      markers: markers.map((m) => ({
        text: String((m as Record<string, unknown>)['text']),
        weight: Number((m as Record<string, unknown>)['weight']),
      })),
      minimumScore: t['minimumScore'],
      confidentScore: t['confidentScore'],
      facts: facts.map((f) => ({
        fact: (f as Record<string, unknown>)['fact'] as FactName,
        labels: ((f as Record<string, unknown>)['labels'] as string[]).slice(),
      })),
    });
  }
  if (types.length === 0) return bad('At least one document type is defined');
  if (new Set(types.map((t) => t.kind)).size !== types.length) return bad('A kind is defined twice');
  const claimed = types.flatMap((t) => t.satisfies);
  // A checklist type stands for one kind only: otherwise "is this what was declared?" has two answers.
  if (new Set(claimed).size !== claimed.length) return bad('A checklist document type is claimed by two kinds');
  return ok({
    catalogueVersion: raw['catalogueVersion'],
    engine: 'RULES',
    ambiguityMargin: raw['ambiguityMargin'],
    types,
  });
}

// -- Normalisation ---------------------------------------------------------------------

const ARABIC_INDIC = /[٠-٩]/g;
const EASTERN_ARABIC_INDIC = /[۰-۹]/g;
const TASHKEEL_AND_TATWEEL = /[ً-ٰٟـ]/g;

/**
 * Text as it is compared: digits in Latin form, Arabic without diacritics or
 * elongation and with its interchangeable letters unified (alef forms, yaa
 * and alef maqsura, taa marbuta and haa), Latin lower-cased, whitespace
 * collapsed. Applied to the document and to every marker and label alike.
 */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(TASHKEEL_AND_TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** All the text an extraction read: each page's plain text and every table cell, in reading order. */
export function textOf(content: ExtractedContent): string {
  return content.pages
    .map((p) => [p.plainText, ...p.tables.flatMap((t) => t.cells.map((c) => c.text))].join(' '))
    .join('\n');
}

// -- Classification --------------------------------------------------------------------

export type Classification =
  | {
      readonly status: 'RECOGNISED';
      /** The kind recognised (a bank statement), not a checklist type: see `DocumentTypeDefinition.satisfies`. */
      readonly kind: string;
      /** Per ten thousand: the score against the kind's confident score, capped. */
      readonly confidencePerTenThousand: number;
      readonly markersMatched: number;
    }
  | { readonly status: 'AMBIGUOUS'; readonly candidates: readonly string[] }
  | { readonly status: 'UNRECOGNISED' }
  /** Nothing could be read: an image the engine does not read, or a document with no text. */
  | { readonly status: 'UNREADABLE'; readonly reason: 'NO_TEXT' | 'MEDIA_NOT_READ' };

function score(text: string, t: DocumentTypeDefinition): { readonly score: number; readonly matched: number } {
  let s = 0;
  let matched = 0;
  for (const m of t.markers) {
    if (text.includes(normaliseText(m.text))) {
      s += m.weight;
      matched += 1;
    }
  }
  return { score: s, matched };
}

/** Which of the catalogue's types the text is, if any one clearly. */
export function classify(text: string, catalogue: DocumentTypeCatalogue): Classification {
  const normalised = normaliseText(text);
  if (normalised.length === 0) return { status: 'UNREADABLE', reason: 'NO_TEXT' };
  const scored = catalogue.types
    .map((t) => ({ t, ...score(normalised, t) }))
    .filter((x) => x.score >= x.t.minimumScore)
    .sort((a, b) => b.score - a.score || a.t.kind.localeCompare(b.t.kind));
  const best = scored[0];
  if (best === undefined) return { status: 'UNRECOGNISED' };
  const close = scored.filter((x) => best.score - x.score < catalogue.ambiguityMargin);
  if (close.length > 1) return { status: 'AMBIGUOUS', candidates: close.map((x) => x.t.kind) };
  return {
    status: 'RECOGNISED',
    kind: best.t.kind,
    confidencePerTenThousand: Math.min(10_000, Math.floor((best.score * 10_000) / best.t.confidentScore)),
    markersMatched: best.matched,
  };
}

// -- Dates -----------------------------------------------------------------------------

export interface CivilDate {
  /** yyyy-mm-dd as written: a Gregorian date, or a Hijri (Umm al-Qura) one. Never converted here. */
  readonly date: string;
  readonly calendar: 'GREGORIAN' | 'HIJRI';
}

export type Fact =
  | { readonly fact: 'ISSUE_DATE' | 'EXPIRY_DATE'; readonly status: 'READ'; readonly value: CivilDate }
  | { readonly fact: 'STATEMENT_PERIOD'; readonly status: 'READ'; readonly from: CivilDate; readonly to: CivilDate }
  /** The label was found but no date could be read after it, or the label was not found at all. */
  | { readonly fact: FactName; readonly status: 'NOT_READ' };

const DATE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g;
/** How far after its label a date may stand, in characters of normalised text. */
const DATE_WINDOW = 60;

function civilDate(y: number, m: number, d: number): CivilDate | undefined {
  const calendar = y >= 1900 && y <= 2200 ? 'GREGORIAN' : y >= 1300 && y <= 1600 ? 'HIJRI' : undefined;
  if (calendar === undefined || m < 1 || m > 12 || d < 1 || d > (calendar === 'HIJRI' ? 30 : 31)) return undefined;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return { date: `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`, calendar };
}

/** The readable dates in a stretch of text, in order. Day-first where the year is last (dd/mm/yyyy), as written in the Kingdom. */
function datesIn(text: string): CivilDate[] {
  const out: CivilDate[] = [];
  for (const m of text.matchAll(DATE)) {
    const c =
      m[1] !== undefined
        ? civilDate(Number(m[1]), Number(m[2]), Number(m[3]))
        : civilDate(Number(m[6]), Number(m[5]), Number(m[4]));
    if (c !== undefined) out.push(c);
  }
  return out;
}

/** The dates a document type declares, read after their labels. */
export function readFacts(text: string, definition: DocumentTypeDefinition): readonly Fact[] {
  const normalised = normaliseText(text);
  // The registration number is compared, never kept: it is not a fact on the record (see matchRegistration).
  return definition.facts
    .filter((f) => f.fact !== 'REGISTRATION_NUMBER')
    .map((f): Fact => {
      for (const label of f.labels) {
        const at = normalised.indexOf(normaliseText(label));
        if (at < 0) continue;
        const after = normalised.slice(
          at + normaliseText(label).length,
          at + normaliseText(label).length + DATE_WINDOW * 2,
        );
        const dates = datesIn(after.slice(0, f.fact === 'STATEMENT_PERIOD' ? DATE_WINDOW * 2 : DATE_WINDOW));
        if (f.fact === 'STATEMENT_PERIOD') {
          const [from, to] = dates;
          if (from !== undefined && to !== undefined) return { fact: f.fact, status: 'READ', from, to };
          continue;
        }
        const first = dates[0];
        if (first !== undefined && f.fact !== 'REGISTRATION_NUMBER')
          return { fact: f.fact, status: 'READ', value: first };
      }
      return { fact: f.fact, status: 'NOT_READ' };
    });
}

// -- Matching against the application (D2): outcomes only -------------------------------

/** What the reading found when it compared the document with the application. The values compared are not kept. */
export interface Matches {
  /** The registration number after its label is the application's, another one, or none could be read. */
  readonly registration?: 'MATCHES' | 'DIFFERS' | 'NOT_READ';
  /** The business's name appears on the document, in either script — or was not found. */
  readonly name?: 'FOUND' | 'NOT_FOUND';
}

/** What the application expects a document to carry, passed in for the comparison and discarded after it. */
export interface Expectations {
  readonly registrationNumber?: string;
  /** The business's names (English, Arabic). */
  readonly names?: readonly string[];
}

const digitsOnly = (s: string): string => normaliseText(s).replace(/\D/g, '');
/** A run of at least five digits, which may be grouped by spaces or dashes as printed. */
const NUMBER_RUN = /\d[\d -]{3,}\d/g;

/** Compare the registration number printed after one of the kind's labels with the application's. */
export function matchRegistration(
  text: string,
  definition: DocumentTypeDefinition,
  expected: string,
): Matches['registration'] {
  const want = digitsOnly(expected);
  const labels = definition.facts.find((f) => f.fact === 'REGISTRATION_NUMBER')?.labels ?? [];
  if (want.length < 5 || labels.length === 0) return 'NOT_READ';
  const normalised = normaliseText(text);
  for (const label of labels) {
    const l = normaliseText(label);
    const at = normalised.indexOf(l);
    if (at < 0) continue;
    const run = normalised.slice(at + l.length, at + l.length + DATE_WINDOW).match(NUMBER_RUN)?.[0];
    if (run === undefined) continue;
    return digitsOnly(run) === want ? 'MATCHES' : 'DIFFERS';
  }
  return 'NOT_READ';
}

/** Words a legal name carries that say nothing about which business it is. */
const LEGAL_FORMS = new Set([
  'llc',
  'l.l.c',
  'co',
  'co.',
  'company',
  'establishment',
  'est',
  'est.',
  'ltd',
  'limited',
  'trading',
  'fze',
  'fzco',
  'شركه',
  'مؤسسه',
  'ذ.م.م',
  'المحدوده',
]);

/** Every distinctive word of one of the business's names appears in the text. */
export function matchName(text: string, names: readonly string[]): Matches['name'] {
  const normalised = normaliseText(text);
  for (const name of names) {
    const words = normaliseText(name)
      .split(' ')
      .filter((w) => w.length > 1 && !LEGAL_FORMS.has(w));
    if (words.length > 0 && words.every((w) => normalised.includes(w))) return 'FOUND';
  }
  return 'NOT_FOUND';
}

// -- Findings --------------------------------------------------------------------------

export type CheckOutcome = 'PASS' | 'FAIL' | 'UNREADABLE';

export interface CheckResult {
  /** TYPE_MATCHES_DECLARED (D1); the content checks a checklist item declares (D2, document-checks.ts). */
  readonly check: string;
  readonly outcome: CheckOutcome;
  /** What the check saw: a date as written, a period. Never a name or a number from the page. */
  readonly observed?: string;
  readonly calendar?: 'HIJRI';
  /** The limit it was held to: `45d`, `12m`. */
  readonly limit?: string;
}

export interface Understanding {
  readonly classification: Classification;
  readonly facts: readonly Fact[];
  readonly pagesRead: number;
  /** Present where the reading was given expectations to compare (D2). */
  readonly matches?: Matches;
}

export interface DocumentFindings extends Understanding {
  /** The type the document was presented as. */
  readonly declaredType: string;
  readonly checks: readonly CheckResult[];
  /** Which engine read it, and the catalogue version it read against: a finding is reproducible from these. */
  readonly engine: string;
  readonly catalogueVersion: string;
  readonly source: 'LIVE' | 'FIXTURE';
}

/**
 * The findings on a document presented as `declaredType`. D1's one check: is
 * the kind read one that may be presented as the declared type? Unreadable
 * where nothing was recognised — said so, never guessed.
 */
export function findingsOf(
  understanding: Understanding,
  declaredType: string,
  catalogue: DocumentTypeCatalogue,
  meta: { readonly engine: string; readonly source: 'LIVE' | 'FIXTURE' },
  /** D2: the checklist item's declared checks and the reading date; absent, only the type is checked (D1). */
  content?: { readonly rules: readonly DocumentCheckRule[]; readonly context: CheckContext },
): DocumentFindings {
  const c = understanding.classification;
  const recognised = c.status === 'RECOGNISED' ? catalogue.types.find((t) => t.kind === c.kind) : undefined;
  const typeCheck: CheckResult = {
    check: 'TYPE_MATCHES_DECLARED',
    outcome: recognised === undefined ? 'UNREADABLE' : recognised.satisfies.includes(declaredType) ? 'PASS' : 'FAIL',
  };
  const contentChecks =
    content === undefined
      ? []
      : evaluateChecks(content.rules, understanding, typeCheck.outcome === 'PASS', content.context);
  return {
    ...understanding,
    declaredType,
    checks: [typeCheck, ...contentChecks],
    catalogueVersion: catalogue.catalogueVersion,
    ...meta,
  };
}

/** The kind a checklist document type stands for, if the catalogue knows it. */
export const kindFor = (catalogue: DocumentTypeCatalogue, documentType: string): string | undefined =>
  catalogue.types.find((t) => t.satisfies.includes(documentType))?.kind;

// -- The engine port and the rules engine -----------------------------------------------

/**
 * Reading a document into findings. A port: the first implementation is the
 * rules below, over the institution's document engine; an AI model is a
 * second implementation returning the same `Understanding`, selected per
 * tenant once its hosting is approved. Unavailability is a typed outcome, and
 * an unread document is still presented — findings are an aid, never a gate.
 */
export interface DocumentUnderstandingPort {
  /** Names the engine and its version, recorded on every finding. */
  readonly engine: string;
  readonly source: 'LIVE' | 'FIXTURE';
  understand(params: {
    readonly tenantId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly catalogue: DocumentTypeCatalogue;
    /** What the application expects the document to carry (D2), compared during the reading and not kept. */
    readonly expect?: Expectations;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<Understanding>>>;
}

/** Engine name and version for the rules engine: bump the version when the reading below changes. */
export const RULES_ENGINE = 'rules@1';

/** The rules engine, over a text extraction (the document engine, or its demonstration stand-in). */
export function rulesEngine(extraction: DocumentExtractionPort): DocumentUnderstandingPort {
  return {
    engine: RULES_ENGINE,
    source: extraction.source,
    async understand(p): Promise<Result<RailOutcome<Understanding>>> {
      // The document engine reads PDFs; an image is presented unread rather than guessed at.
      if (p.mediaType !== 'application/pdf')
        return ok({
          kind: 'ANSWERED',
          value: { classification: { status: 'UNREADABLE', reason: 'MEDIA_NOT_READ' }, facts: [], pagesRead: 0 },
        });
      const extracted = await extraction.extract({
        tenantId: p.tenantId,
        pdf: p.bytes,
        correlationId: p.correlationId,
      });
      if (!extracted.ok) return extracted;
      if (extracted.value.kind !== 'ANSWERED') return ok(extracted.value);
      const text = textOf(extracted.value.value);
      const classification = classify(text, p.catalogue);
      const definition =
        classification.status === 'RECOGNISED'
          ? p.catalogue.types.find((t) => t.kind === classification.kind)
          : undefined;
      // Compared here, while the text is in hand, and only the outcomes leave: the number and name read are dropped.
      const registration =
        definition === undefined || p.expect?.registrationNumber === undefined
          ? undefined
          : matchRegistration(text, definition, p.expect.registrationNumber);
      const name = p.expect?.names === undefined ? undefined : matchName(text, p.expect.names);
      const matches: Matches = {
        ...(registration === undefined ? {} : { registration }),
        ...(name === undefined ? {} : { name }),
      };
      return ok({
        kind: 'ANSWERED',
        value: {
          classification,
          facts: definition === undefined ? [] : readFacts(text, definition),
          pagesRead: extracted.value.value.pages.length,
          ...(Object.keys(matches).length === 0 ? {} : { matches }),
        },
      });
    },
  };
}
