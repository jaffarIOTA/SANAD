/**
 * Both directions, and parity between them.
 *
 * §11 makes "reviewed in RTL **and** LTR" a condition of done. A human review
 * catches what looks wrong; it does not reliably catch what is *missing* — an
 * Arabic string that quietly fell back to English, a status conveyed only by a
 * colour, an icon carrying meaning no screen reader will ever announce.
 *
 * Those are the things asserted here. Layout still needs eyes on it.
 *
 * Note what is deliberately *not* asserted: no component emits `dir`. Direction
 * is set once on `<html>` from the locale, and a component that sets its own
 * is a component that will be wrong when embedded in the other direction.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BrandLockup,
  BrandMark,
  Card,
  ControlRejection,
  DualDate,
  LanguageSwitch,
  PrimaryAction,
  Status,
} from '@sanad/design/primitives.tsx';
import { BarList, Indicator, StageBar, StatTile } from '@sanad/design/charts.tsx';
import { Icon, IconChip } from '@sanad/design/icons.tsx';
import { STRINGS, isRtl, htmlLang, localeFromSegment, type Locale } from '@sanad/i18n/strings.ts';

const LOCALES: readonly Locale[] = ['ar-SA', 'en-SA'];

/** Every design component, with props valid in either direction. */
const COMPONENTS: readonly { name: string; render: (locale: Locale) => string }[] = [
  { name: 'BrandMark', render: () => renderToStaticMarkup(<BrandMark size={24} />) },
  { name: 'BrandLockup', render: () => renderToStaticMarkup(<BrandLockup size={24} />) },
  {
    name: 'DualDate',
    render: (locale) =>
      renderToStaticMarkup(
        <DualDate gregorian="22 September 2026" hijri="١٠ ربيع الآخر ١٤٤٨" locale={locale} />,
      ),
  },
  {
    name: 'Status',
    render: (locale) =>
      renderToStaticMarkup(
        <Status tone="progress" label={locale === 'ar-SA' ? 'قيد المعالجة' : 'In progress'} />,
      ),
  },
  {
    name: 'ControlRejection',
    render: (locale) =>
      renderToStaticMarkup(
        <ControlRejection
          control="SH-10"
          controlLabel={locale === 'ar-SA' ? 'الضابط' : 'Control'}
          explanation={
            locale === 'ar-SA'
              ? 'سبق تمويل هذه الفاتورة.'
              : 'This invoice has already been financed.'
          }
        />,
      ),
  },
  {
    name: 'Card',
    render: (locale) =>
      renderToStaticMarkup(<Card>{locale === 'ar-SA' ? 'محتوى' : 'Content'}</Card>),
  },
  {
    name: 'PrimaryAction',
    render: (locale) =>
      renderToStaticMarkup(
        <PrimaryAction href="/ar">{locale === 'ar-SA' ? 'متابعة' : 'Continue'}</PrimaryAction>,
      ),
  },
  {
    name: 'LanguageSwitch',
    render: (locale) =>
      renderToStaticMarkup(<LanguageSwitch current={locale === 'ar-SA' ? 'ar' : 'en'} />),
  },
  {
    name: 'StatTile',
    render: (locale) =>
      renderToStaticMarkup(
        <StatTile
          icon="inbox"
          label={locale === 'ar-SA' ? 'بانتظار المراجعة' : 'Awaiting review'}
          value="7"
        />,
      ),
  },
  {
    name: 'StageBar',
    render: (locale) =>
      renderToStaticMarkup(
        <StageBar
          title={locale === 'ar-SA' ? 'المراحل' : 'Stages'}
          emptyLabel={locale === 'ar-SA' ? 'لا شيء' : 'None'}
          segments={[
            { id: 'a', label: locale === 'ar-SA' ? 'أول' : 'First', value: 3, colour: '--color-stage-1' },
            { id: 'b', label: locale === 'ar-SA' ? 'ثان' : 'Second', value: 1, colour: '--color-stage-2' },
          ]}
        />,
      ),
  },
  {
    name: 'BarList',
    render: (locale) =>
      renderToStaticMarkup(
        <BarList
          title={locale === 'ar-SA' ? 'حسب القناة' : 'By channel'}
          emptyLabel={locale === 'ar-SA' ? 'لا شيء' : 'None'}
          rows={[{ label: locale === 'ar-SA' ? 'قناة' : 'Channel', value: 4 }]}
        />,
      ),
  },
  {
    name: 'Indicator',
    render: (locale) =>
      renderToStaticMarkup(
        <ul>
          <Indicator label={locale === 'ar-SA' ? 'مؤشر' : 'Indicator'} value="0" tone="good" />
        </ul>,
      ),
  },
  { name: 'Icon', render: () => renderToStaticMarkup(<Icon name="search" />) },
  { name: 'IconChip', render: () => renderToStaticMarkup(<IconChip name="coins" />) },
];

describe('every component renders in both directions', () => {
  for (const { name, render } of COMPONENTS) {
    for (const locale of LOCALES) {
      it(`${name} renders under ${locale}`, () => {
        const html = render(locale);
        expect(html.length).toBeGreaterThan(0);
      });
    }
  }

  it('no component sets its own direction', () => {
    const offenders: string[] = [];
    for (const { name, render } of COMPONENTS) {
      for (const locale of LOCALES) {
        if (/\sdir="(rtl|ltr)"/.test(render(locale))) offenders.push(`${name} @ ${locale}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('§6 — meaning is never carried by colour or glyph alone', () => {
  it('every icon is hidden from assistive technology', () => {
    // An icon in this product always sits beside its own label. If one ever
    // needs to be announced, it is being used to carry meaning by itself,
    // which is the thing this asserts against.
    const html = renderToStaticMarkup(
      <>
        <Icon name="search" />
        <IconChip name="coins" />
      </>,
    );
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg).toContain('aria-hidden');
  });

  it('a status renders its label as text, not only a colour', () => {
    const html = renderToStaticMarkup(<Status tone="blocked" label="Blocked" />);
    expect(html).toContain('Blocked');
  });

  it('an indicator renders its label and its number', () => {
    const html = renderToStaticMarkup(
      <ul>
        <Indicator label="Open incidents" value="0" tone="good" />
      </ul>,
    );
    expect(html).toContain('Open incidents');
    expect(html).toContain('0');
  });

  it('a stage bar legend carries every label and count, so it doubles as the table', () => {
    const html = renderToStaticMarkup(
      <StageBar
        title="Stages"
        emptyLabel="None"
        segments={[
          { id: 'a', label: 'Awaiting review', value: 3, colour: '--color-stage-1' },
          { id: 'b', label: 'Approved', value: 1, colour: '--color-stage-2' },
        ]}
      />,
    );
    expect(html).toContain('Awaiting review');
    expect(html).toContain('Approved');
    expect(html).toContain('>3<');
    expect(html).toContain('>1<');
  });
});

describe('§6 — both calendars, wherever a date has contractual effect', () => {
  it.each(LOCALES)('renders both calendars under %s', (locale) => {
    const html = renderToStaticMarkup(
      <DualDate gregorian="22 September 2026" hijri="١٠ ربيع الآخر ١٤٤٨" locale={locale} />,
    );
    expect(html).toContain('22 September 2026');
    expect(html).toContain('ربيع الآخر');
  });

  it('leads with Hijri in Arabic and Gregorian in English', () => {
    const arabic = renderToStaticMarkup(
      <DualDate gregorian="22 September 2026" hijri="١٠ ربيع الآخر ١٤٤٨" locale="ar-SA" />,
    );
    const english = renderToStaticMarkup(
      <DualDate gregorian="22 September 2026" hijri="١٠ ربيع الآخر ١٤٤٨" locale="en-SA" />,
    );
    expect(arabic.indexOf('ربيع')).toBeLessThan(arabic.indexOf('September'));
    expect(english.indexOf('September')).toBeLessThan(english.indexOf('ربيع'));
  });
});

describe('the language switch', () => {
  it('names the other language in its own script', () => {
    // Whoever needs this control is, by definition, not reading the language
    // currently on screen. "Arabic" is no use to them.
    expect(renderToStaticMarkup(<LanguageSwitch current="en" />)).toContain('العربية');
    expect(renderToStaticMarkup(<LanguageSwitch current="ar" />)).toMatch(/English/i);
  });

  it('marks the target language on the link', () => {
    const html = renderToStaticMarkup(<LanguageSwitch current="ar" />);
    // Matched case-insensitively: React 19 serialises this as `hrefLang`, and
    // HTML attribute names are ASCII case-insensitive, so both are correct.
    expect(html).toMatch(/hreflang="en"/i);
    expect(html).toMatch(/\slang="en"/i);
  });
});

describe('§6 — content parity between the two languages', () => {
  it('defines the same keys in both catalogues, recursively', () => {
    const shape = (value: unknown): unknown =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value)
              .map(([k, v]) => [k, shape(v)] as const)
              .sort(([a], [b]) => a.localeCompare(b)),
          )
        : typeof value;

    expect(shape(STRINGS['ar-SA'])).toEqual(shape(STRINGS['en-SA']));
  });

  it('leaves no string empty and no Arabic string untranslated', () => {
    const empty: string[] = [];
    const untranslated: string[] = [];

    const walk = (locale: Locale, value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (value.trim().length === 0) empty.push(`${locale}.${path}`);
        // An Arabic entry with no Arabic letters in it is an English string
        // that was never translated. Identifiers and codes are exempt.
        if (locale === 'ar-SA' && /[A-Za-z]{4,}/.test(value) && !/[؀-ۿ]/.test(value)) {
          untranslated.push(`${path} = ${value}`);
        }
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(locale, v, `${path}.${k}`);
      }
    };

    for (const locale of LOCALES) walk(locale, STRINGS[locale], '');

    expect(empty).toEqual([]);
    expect(untranslated).toEqual([]);
  });

  it('maps each locale to the right direction and language tag', () => {
    expect(isRtl('ar-SA')).toBe(true);
    expect(isRtl('en-SA')).toBe(false);
    expect(htmlLang('ar-SA')).toBe('ar');
    expect(htmlLang('en-SA')).toBe('en');
    expect(localeFromSegment('ar')).toBe('ar-SA');
    expect(localeFromSegment('en')).toBe('en-SA');
    expect(localeFromSegment('fr')).toBeUndefined();
  });
});
