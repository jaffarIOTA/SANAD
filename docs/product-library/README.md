# SANAD product library

The branded documents that pre-sales, delivery and clients read. Sources are Markdown in `src/`; the
built PDF and Word files are in `dist/` and are committed so that people without the toolchain can use them.

| File | Audience | Classification |
|---|---|---|
| `00-sanad-at-a-glance` | Prospects | Client |
| `01-sanad-product-guide-ksa` | Saudi institutions | Client |
| `02-sanad-product-guide-uae` | UAE institutions | Client |
| `03-sanad-api-catalogue` | Institutions' integration teams | Client — technical |
| `04-sanad-presales-technical-pack-ksa` | IOTA pre-sales and delivery | **Internal — never send** |
| `05-sanad-presales-technical-pack-uae` | IOTA pre-sales and delivery | **Internal — never send** |

The internal packs hold the decisions register (taken, pending, to be considered), illustrative
configuration, rail verification items, open security items and the demonstration script.

## Build

```sh
node docs/product-library/build.mjs          # every document
node docs/product-library/build.mjs 04       # only files whose name contains "04"
```

Requires Google Chrome (PDF, via headless `--print-to-pdf`) and LibreOffice `soffice` (Word). No npm
dependencies. Fonts come from `packages/design/fonts`, the SANAD marks from `docs/brand/logo` and the IOTA
mark from `assets/`.

## Writing

Front matter: `title`, `subtitle`, `edition`, `classification` (anything containing "Internal" switches to
the red internal header), `version`, `date`, `toc: no` to drop the contents page, `layout: compact` to stop
each section starting a new page.

Body: ordinary Markdown headings, lists, tables and code, plus callouts
(`:::note|warn|internal|key Title` … `:::`) and `\pagebreak`.

## Keeping it true

These documents describe the product as at their date. When a milestone merges, a rail is verified or a
pending decision is taken, update the status words and the registers here, then rebuild. The sources of
truth are `apps/ops/src/server/modules.ts`, `pending.md`, the ADRs and the adapter READMEs. The SANAD mark
is the interim one (`docs/brand/README.md`); its licence for use beyond the synthetic site is unconfirmed.
