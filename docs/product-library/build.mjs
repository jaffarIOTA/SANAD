#!/usr/bin/env node
/**
 * Builds the SANAD product library: each Markdown source in ./src becomes a
 * branded PDF (Chrome, headless) and a Word document (LibreOffice), in ./dist.
 *
 *   node docs/product-library/build.mjs            every document
 *   node docs/product-library/build.mjs api        those whose file name contains "api"
 *
 * No dependencies. The Markdown is the subset the sources use: front matter,
 * headings, paragraphs, lists (two levels), tables, block quotes, fenced code,
 * callouts (::: note|warn|internal … :::), page breaks (\pagebreak), inline
 * bold, italic, code and links, and raw HTML lines.
 *
 * Needs Google Chrome and LibreOffice (soffice) on the machine that builds.
 */
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const src = join(here, 'src');
const dist = join(here, 'dist');
const work = join(here, '.build');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SOFFICE = process.env.SOFFICE ?? 'soffice';

// -- Markdown, the subset the sources use ----------------------------------------------

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `@@CODE${String(codes.length - 1)}@@`;
  });
  s = escape(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/&lt;br&gt;/g, '<br>');
  return s.replace(/@@CODE(\d+)@@/g, (_m, i) => `<code>${escape(codes[Number(i)])}</code>`);
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const toc = [];
  let i = 0;
  const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isList = (l) => /^(\s*)([-*]|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.trim() === '\\pagebreak') {
      html.push('<div class="page-break"></div>');
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;
      html.push(`<pre><code>${escape(body.join('\n'))}</code></pre>`);
      continue;
    }
    const callout = /^:::\s*(\w+)\s*(.*)$/.exec(line);
    if (callout) {
      const body = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== ':::') body.push(lines[i++]);
      i += 1;
      const title = callout[2] ? `<p class="callout-title">${inline(callout[2])}</p>` : '';
      html.push(`<div class="callout callout-${callout[1]}">${title}${render(body.join('\n')).html}</div>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = inline(heading[2]);
      const id = slug(heading[2]);
      if (level <= 2) toc.push({ level, text, id });
      html.push(`<h${String(level)} id="${id}">${text}</h${String(level)}>`);
      i += 1;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }
    if (line.startsWith('<')) {
      html.push(line);
      i += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${render(body.join('\n')).html}</blockquote>`);
      continue;
    }
    if (isTable(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(line);
      const align = lines[i + 1]
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => (/^\s*:-+:\s*$/.test(c) ? 'center' : /-+:\s*$/.test(c) ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i++]));
      // An identifier such as DT-13 or V-01 in the first column never breaks at its hyphen.
      const ids = (c) => c.replace(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g, '<span class="nw">$&</span>');
      const td = (c, j, tag) =>
        `<${tag}${align[j] ? ` class="${align[j]}"` : ''}>${j === 0 && tag === 'td' ? ids(c) : c}</${tag}>`;
      html.push(
        `<table><thead><tr>${head.map((c, j) => td(c, j, 'th')).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c, j) => td(c, j, 'td')).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (isList(line)) {
      const out = [];
      const stack = [];
      while (i < lines.length && (isList(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) {
          out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(lines[i].trim())}</li>`);
          i += 1;
          continue;
        }
        const depth = Math.floor(m[1].length / 2);
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length > depth + 1) out.push(`</${stack.pop()}></li>`);
        if (stack.length < depth + 1) {
          if (stack.length > 0) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '');
          out.push(`<${tag}>`);
          stack.push(tag);
        }
        out.push(`<li>${inline(m[3])}</li>`);
        i += 1;
      }
      while (stack.length > 0) out.push(stack.length > 1 ? `</${stack.pop()}></li>` : `</${stack.pop()}>`);
      html.push(out.join(''));
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4}\s|```|:::|>|<|\s*\|)/.test(lines[i]) &&
      !isList(lines[i])
    )
      para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: html.join('\n'), toc };
}

// -- Front matter and the page --------------------------------------------------------

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = Object.fromEntries(
    m[1]
      .split('\n')
      .map((l) => /^(\w+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((x) => [x[1], x[2].replace(/^"|"$/g, '')]),
  );
  return { meta, body: text.slice(m[0].length) };
}

const dataUri = (path, type) => `data:${type};base64,${readFileSync(path).toString('base64')}`;

function page(meta, body, toc, forWord) {
  const css = readFileSync(join(here, 'style.css'), 'utf8').replace(
    /url\("FONTS\/([^"]+)"\)/g,
    (_m, f) => `url("${dataUri(join(repo, 'packages/design/fonts', f), 'font/woff2')}")`,
  );
  const iota = dataUri(join(here, 'assets', 'iota-mark.png'), 'image/png');
  const sanad = dataUri(join(repo, 'docs/brand/logo', 'sanad-logo-en-color.png'), 'image/png');
  const sanadAr = dataUri(join(repo, 'docs/brand/logo', 'sanad-logo-ar-color.png'), 'image/png');
  // LibreOffice's HTML import reads attributes more faithfully than CSS: the Word edition gets them.
  if (forWord)
    body = body
      .replace(/<table>/g, '<table border="1" cellspacing="0" cellpadding="5" width="100%">')
      .replace(
        /<th( class="\w+")?>([\s\S]*?)<\/th>/g,
        '<th bgcolor="#343c6a" align="left"><font color="#ffffff">$2</font></th>',
      )
      .replace(
        /<div class="callout callout-(\w+)">([\s\S]*?)<\/div>/g,
        (_m, kind, inner) =>
          `<table border="1" cellspacing="0" cellpadding="8" width="100%"><tr><td bgcolor="${
            { warn: '#fdf0dc', internal: '#fde8ec' }[kind] ?? '#e9efff'
          }">${inner}</td></tr></table><p></p>`,
      )
      .replace(/<h2 /g, meta.layout === 'compact' ? '<h2 ' : '<h2 style="page-break-before: always" ')
      .replace(/<div class="page-break"><\/div>/g, '<p style="page-break-before: always"></p>');
  const classification = meta.classification ?? 'Client';
  const internal = /internal/i.test(classification);
  const contents =
    meta.toc === 'no'
      ? ''
      : `<section class="toc"><h2>Contents</h2><ol>${toc
          .filter((t) => t.level === 2)
          .map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`)
          .join('')}</ol></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(meta.title ?? 'SANAD')}</title>
${forWord ? '' : `<style>${css}</style>`}
${
  forWord
    ? `<style>body,p,li,td,th{font-family:Arial,'Helvetica Neue',sans-serif;color:#1d2233;font-size:10pt}
h1,h2,h3,h4{font-family:Arial,'Helvetica Neue',sans-serif;color:#343c6a}h2{color:#2d60ff;font-size:16pt}h3{color:#1f4ae0;font-size:12pt}
td,th{font-size:9pt;vertical-align:top}code{font-family:Consolas,monospace;font-size:9pt}</style>`
    : ''
}
</head><body class="${internal ? 'internal' : 'client'}${meta.layout === 'compact' ? ' compact' : ''}">
<section class="cover">
  <div class="cover-brands"><img class="iota" src="${iota}" alt="IOTA" ${forWord ? 'width="40"' : ''}><span class="iota-name">IOTA Technologies</span></div>
  <div class="cover-main">
    <img class="sanad" src="${sanad}" alt="SANAD" ${forWord ? 'width="260"' : ''}>
    <img class="sanad-ar" src="${sanadAr}" alt="سند" ${forWord ? 'width="120"' : ''}>
    <h1 class="cover-title">${escape(meta.title ?? '')}</h1>
    <p class="cover-subtitle">${escape(meta.subtitle ?? '')}</p>
    ${meta.edition ? `<p class="cover-edition">${escape(meta.edition)}</p>` : ''}
  </div>
  <div class="cover-foot">
    <p class="classification ${internal ? 'is-internal' : ''}">${escape(classification)}</p>
    <p>Version ${escape(meta.version ?? '1.0')} · ${escape(meta.date ?? '')}</p>
    <p>IOTA Labs · Riyadh · Dubai · London</p>
  </div>
</section>
${forWord ? '<p style="page-break-before: always"></p>' : ''}
${contents}
<main>${body}</main>
</body></html>`;
}

// -- Building -------------------------------------------------------------------------

function build(file) {
  const { meta, body } = frontMatter(readFileSync(join(src, file), 'utf8'));
  const { html, toc } = render(body);
  const name = file.replace(/\.md$/, '');
  const htmlPath = join(work, `${name}.html`);
  const wordPath = join(work, `${name}.word.html`);
  writeFileSync(htmlPath, page(meta, html, toc, false));
  writeFileSync(wordPath, page(meta, html, toc, true));
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=4000',
      `--print-to-pdf=${join(dist, `${name}.pdf`)}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(SOFFICE, ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', work, wordPath], {
    stdio: 'ignore',
  });
  const docx = join(work, `${name}.word.docx`);
  if (existsSync(docx)) writeFileSync(join(dist, `${name}.docx`), readFileSync(docx));
  console.log(`built ${name}.pdf and ${name}.docx`);
}

mkdirSync(dist, { recursive: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const only = process.argv[2];
for (const f of readdirSync(src).filter((x) => x.endsWith('.md') && (only === undefined || x.includes(only)))) build(f);
rmSync(work, { recursive: true, force: true });
