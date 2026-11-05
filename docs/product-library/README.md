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
| `06-sanad-bnpl-demo-runbook-uae` | IOTA presenters | **Internal — never send** |

The internal packs hold the decisions register (taken, pending, to be considered), illustrative
configuration, rail verification items, open security items and the demonstration script.

## Build

```sh
node docs/product-library/build.mjs          # every document
node docs/product-library/build.mjs 04       # only files whose name contains "04"
```

Requires Google Chrome (PDF, via headless `--print-to-pdf`), LibreOffice `soffice` (Word) and a Python 3.10+
with reportlab, pypdf, python-docx and Pillow, once per machine:

```sh
cd docs/product-library && python3 -m venv .venv && .venv/bin/pip install reportlab pypdf python-docx Pillow
```

(`BRAND_PYTHON` points the build at another Python.) No npm dependencies.

## Brand

Every document is built to the IOTA brand, the `iota-branding` skill:

- **Typeface:** IBM Plex Sans Condensed, Regular for text and Bold for headings. There are no italics; emphasis is
  bold or IOTA blue. IBM Plex Sans Arabic is used for Arabic code points only, because the Condensed face has no
  Arabic. Commands keep a monospace face.
- **Colour:** IOTA blue `#0066FF` is the only accent, on ink, greys and the letterhead's off-white page. A
  callout's kind is shown by its panel (tint, white with a blue border, warm with a blue bar), not by colour.
- **Page and furniture:** US Letter with one-inch side margins. Each PDF page is laid on the IOTA letterhead,
  with the IOTA wordmark, a running header, and the footer `IOTA · <title> · <edition> · Confidential`
  (`Internal, never send` on internal documents) and `Page n of N`.
- **Word:** the Word edition has the same page, ground, header, footer, cover and tables. It embeds the two
  Plex Condensed faces, so it needs no installed font.
- **Tables:** a tinted header with a blue rule, hairlines between rows, and no vertical lines.

`build.mjs` renders the Markdown and `style.css` sets the type. `brand.py` applies the letterhead to the PDF and
the page set-up, cover, fonts and tables to the Word file. The brand assets are in `brand/`: the letterhead, the
logo, and the two fonts with their SIL Open Font License.

## Writing

Front matter: `title`, `subtitle`, `edition`, `classification`, `version`, `date`, `toc: no` to drop the
contents page, and `layout: compact` to stop each section starting a new page.

- `edition` is the document's kind in the header and footer.
- A `classification` containing "Internal" puts the marking at the top of every page and in the footer.
- `SANAD` is prefixed to a `title` that lacks it.

Body: ordinary Markdown headings, lists, tables and code, plus callouts
(`:::note|warn|internal|key Title` … `:::`) and `\pagebreak`.

## Keeping it true

These documents describe the product as at their date. When a milestone merges, a rail is verified or a
pending decision is taken, update the status words and the registers here, then rebuild. The sources of
truth are `apps/ops/src/server/modules.ts`, `pending.md`, the ADRs and the adapter READMEs.
