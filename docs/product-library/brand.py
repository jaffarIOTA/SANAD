"""Applies the IOTA brand (~/.claude/skills/iota-branding) to a product-library document built by build.mjs.

  brand.py pdf  <chrome.pdf> <out.pdf>  <meta.json>   lay each page on the IOTA letterhead, stamp header and footer
  brand.py docx <soffice.docx> <out.docx> <meta.json> letterhead page set-up, brand cover, fonts, tables, no italics

meta.json: {"title", "kind", "family", "classification", "internal", "meta": [[label, value], ...], "disclaimer"}.
Needs reportlab, pypdf, python-docx and Pillow (docs/product-library/.venv, see README.md).
"""
import copy
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "brand")
LETTERHEAD = os.path.join(BRAND, "letterhead.pdf")
LOGO = os.path.join(BRAND, "logo_raw.png")
FONT = "IBM Plex Sans Condensed"
FONT_AR = "IBM Plex Sans Arabic"
MONO = ("mono", "consolas", "courier", "menlo", "liberation mono", "dejavu sans mono")
MONO_FONT = "Consolas"  # in Word on Windows and macOS alike
W, H = 612, 792
BLUE, INK, MUTED, RULE, TINT, PAGE = "0066FF", "1D1D1F", "6B6B6B", "C9C6C0", "EAF1FF", "F6F4F1"


def footer_line(meta):
    tail = "Internal, never send" if meta["internal"] else "Confidential"
    return f"IOTA  ·  {meta['title']}  ·  {meta['kind']}  ·  {tail}"


# -- PDF ------------------------------------------------------------------------------------


def brand_pdf(src, out, meta):
    from pypdf import PageObject, PdfReader, PdfWriter
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas

    pdfmetrics.registerFont(TTFont("C", os.path.join(BRAND, "fonts", "IBMPlexSansCondensed-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("C-B", os.path.join(BRAND, "fonts", "IBMPlexSansCondensed-Bold.ttf")))
    content = PdfReader(src)
    total = len(content.pages)
    buf = io.BytesIO()
    c = Canvas(buf, pagesize=(W, H), initialFontName="C", initialFontSize=8.5)
    for n in range(1, total + 1):
        c.setFont("C-B", 15)
        c.setFillColor(HexColor("#" + INK))
        c.drawString(79, H - 74, "IOTA")
        c.setFont("C", 8.5)
        c.setFillColor(HexColor("#" + MUTED))
        c.drawString(79, H - 86, meta["family"])
        if meta["internal"]:
            c.setFont("C-B", 8.5)
            c.setFillColor(HexColor("#" + BLUE))
            c.drawRightString(W - 72, H - 70, meta["classification"].upper())
        if n > 1:
            c.setFont("C", 8.5)
            c.setFillColor(HexColor("#" + MUTED))
            c.drawRightString(W - 72, H - 82, f"{meta['title']}  ·  {meta['kind']}")
        c.setFont("C", 8.5)
        c.setFillColor(HexColor("#" + MUTED))
        c.drawCentredString(W / 2, 80, footer_line(meta))
        c.drawCentredString(W / 2, 68, f"Page {n} of {total}")
        c.showPage()
    c.save()
    stamps = PdfReader(io.BytesIO(buf.getvalue()))
    letterhead = PdfReader(LETTERHEAD).pages[0]
    writer = PdfWriter()
    for i, p in enumerate(content.pages):
        page = PageObject.create_blank_page(width=W, height=H)
        page.merge_page(letterhead)
        page.merge_page(p)
        page.merge_page(stamps.pages[i])
        writer.add_page(page)
    writer.add_metadata({"/Title": meta["title"], "/Author": "IOTA", "/Subject": meta["kind"]})
    with open(out, "wb") as fh:
        writer.write(fh)


# -- DOCX -----------------------------------------------------------------------------------


def brand_docx(src, out, meta):
    from docx import Document
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Emu, Inches, Pt, RGBColor
    from PIL import Image

    rgb = lambda h: RGBColor.from_string(h)  # noqa: E731
    d = Document(src)

    def el(tag, **attrs):
        e = OxmlElement(tag)
        for k, v in attrs.items():
            e.set(qn(k), v)
        return e

    def set_fonts(rpr, keep_mono=True):
        fonts = rpr.find(qn("w:rFonts"))
        if fonts is None:
            fonts = el("w:rFonts")
            rpr.insert(0, fonts)
        current = (fonts.get(qn("w:ascii")) or "").lower()
        if keep_mono and any(m in current for m in MONO):
            for a in ("w:ascii", "w:hAnsi", "w:eastAsia"):
                fonts.set(qn(a), MONO_FONT)
            return
        for a in list(fonts.attrib):
            if a.endswith("Theme"):
                del fonts.attrib[a]
        for a in ("w:ascii", "w:hAnsi", "w:eastAsia"):
            fonts.set(qn(a), FONT)
        fonts.set(qn("w:cs"), FONT_AR)

    def upright(rpr):
        """No italics: an italic run becomes upright, in IOTA blue."""
        italic = False
        for tag in ("w:i", "w:iCs"):
            for x in rpr.findall(qn(tag)):
                if x.get(qn("w:val")) not in ("0", "false"):
                    italic = True
                rpr.remove(x)
        if italic and rpr.find(qn("w:color")) is None:
            rpr.append(el("w:color", **{"w:val": BLUE}))

    # Styles: the brand face everywhere, headings bold, sized and coloured as in the PDF.
    heading = {1: (20, INK), 2: (16, BLUE), 3: (12.5, BLUE), 4: (11, INK)}
    for st in d.styles:
        if getattr(st, "font", None) is None:
            continue
        rpr = st.element.get_or_add_rPr()
        set_fonts(rpr)
        upright(rpr)
        name = (st.name or "").lower()
        for lvl, (size, color) in heading.items():
            if name in (f"heading {lvl}", f"heading{lvl}"):
                st.font.size, st.font.bold, st.font.color.rgb = Pt(size), True, rgb(color)
    defaults = d.styles.element.find(qn("w:docDefaults"))
    if defaults is not None:
        for rpr in defaults.iter(qn("w:rPr")):
            set_fonts(rpr, keep_mono=False)
    normal = d.styles["Normal"]
    normal.font.size, normal.font.color.rgb = Pt(10.5), rgb(INK)

    body = d.element.body
    for r in body.iter(qn("w:r")):
        rpr = r.find(qn("w:rPr"))
        if rpr is None:
            rpr = el("w:rPr")
            r.insert(0, rpr)
        set_fonts(rpr)
        upright(rpr)

    # Tables: hairlines between rows, a blue rule under the tinted header, no vertical lines.
    # A one-cell table is a callout panel: no rules, its fill only.
    for t in d.tables:
        tblPr = t._tbl.tblPr
        for old in tblPr.findall(qn("w:tblBorders")):
            tblPr.remove(old)
        for tc in t._tbl.iter(qn("w:tc")):
            pr = tc.find(qn("w:tcPr"))
            if pr is not None:
                for old in pr.findall(qn("w:tcBorders")):
                    pr.remove(old)
        borders = el("w:tblBorders")
        callout = len(t.rows) == 1 and len(t.columns) == 1
        for edge in ("top", "left", "right", "insideV", "bottom", "insideH"):
            if callout or edge in ("top", "left", "right", "insideV"):
                borders.append(el(f"w:{edge}", **{"w:val": "nil"}))
            else:
                borders.append(el(f"w:{edge}", **{"w:val": "single", "w:sz": "4", "w:color": RULE}))
        tblPr.append(borders)
        if callout or len(t.rows) < 2:
            continue
        for cell in t.rows[0].cells:
            pr = cell._tc.get_or_add_tcPr()
            pr.append(
                (lambda b: (b.append(el("w:bottom", **{"w:val": "single", "w:sz": "8", "w:color": BLUE})), b)[1])(
                    el("w:tcBorders")
                )
            )
        trPr = t.rows[0]._tr.get_or_add_trPr()
        if trPr.find(qn("w:tblHeader")) is None:
            trPr.append(el("w:tblHeader"))
        for row in t.rows:  # a row never splits across pages
            pr = row._tr.get_or_add_trPr()
            if pr.find(qn("w:cantSplit")) is None:
                pr.insert(0, el("w:cantSplit"))

    # The page: US Letter, the letterhead's margins and off-white ground.
    for old in d.element.findall(qn("w:background")):
        d.element.remove(old)
    d.element.insert(0, el("w:background", **{"w:color": PAGE}))
    if d.settings.element.find(qn("w:displayBackgroundShape")) is None:
        d.settings.element.insert(0, el("w:displayBackgroundShape"))

    logo = Image.open(LOGO)
    x0, y0, x1, y1 = logo.getbbox()
    crop = logo.crop((x0 - 2, y0 - 2, x1 + 2, y1 + 2))
    crop = crop.resize((crop.width * 4, crop.height * 4), Image.LANCZOS)
    logo_png = out + ".logo.png"
    crop.save(logo_png)

    def runs(par, text, size=10.5, color=INK, bold=False):
        r = par.add_run(text)
        r.font.size, r.font.color.rgb, r.bold = Pt(size), rgb(color), bold
        r.font.name = FONT
        return r

    def spacing(par, before=0, after=6, line=1.15):
        pf = par.paragraph_format
        pf.space_before, pf.space_after, pf.line_spacing = Pt(before), Pt(after), line

    def field(par, instr):
        for kind, text in (("begin", None), (None, instr), ("end", None)):
            r = par.add_run()
            r.font.size, r.font.color.rgb, r.font.name = Pt(8.5), rgb(MUTED), FONT
            if kind:
                r._r.append(el("w:fldChar", **{"w:fldCharType": kind}))
            else:
                it = el("w:instrText", **{"xml:space": "preserve"})
                it.text = text
                r._r.append(it)

    for i, sec in enumerate(d.sections):
        sec.page_width, sec.page_height = Inches(8.5), Inches(11)
        sec.left_margin = sec.right_margin = Inches(1)
        sec.top_margin, sec.bottom_margin = Inches(1.83), Inches(1.6)
        sec.header_distance, sec.footer_distance = Inches(0.8), Inches(0.75)
        sec.different_first_page_header_footer = False
        if i > 0:
            sec.header.is_linked_to_previous = True
            sec.footer.is_linked_to_previous = True
            continue
        hdr = sec.header
        hdr.is_linked_to_previous = False
        for p in list(hdr.paragraphs)[1:]:
            p._p.getparent().remove(p._p)
        for tb in list(hdr.tables):
            tb._tbl.getparent().remove(tb._tbl)
        ht = hdr.add_table(rows=1, cols=2, width=Inches(6.74))
        ht.autofit = False
        tblPr = ht._tbl.tblPr
        tblPr.append(el("w:tblInd", **{"w:w": str(int(-0.24 * 1440)), "w:type": "dxa"}))
        mar = el("w:tblCellMar")
        for side in ("left", "right", "top", "bottom"):
            mar.append(el(f"w:{side}", **{"w:w": "0", "w:type": "dxa"}))
        tblPr.append(mar)
        tblPr.append(el("w:tblLayout", **{"w:type": "fixed"}))
        for gc, wd in zip(ht._tbl.tblGrid.findall(qn("w:gridCol")), (0.46, 6.28)):
            gc.set(qn("w:w"), str(int(wd * 1440)))
        c0, c1 = ht.cell(0, 0), ht.cell(0, 1)
        c0.width, c1.width = Inches(0.46), Inches(6.28)
        c0.vertical_alignment = c1.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        lp = c0.paragraphs[0]
        spacing(lp, after=0, line=1.0)
        lp.add_run().add_picture(logo_png, height=Pt(50))
        a = c1.paragraphs[0]
        spacing(a, after=0, line=1.0)
        runs(a, "IOTA", size=15, bold=True)
        if meta["internal"]:
            runs(a, "\t" + meta["classification"].upper(), size=8.5, color=BLUE, bold=True)
            a.paragraph_format.tab_stops.add_tab_stop(Inches(6.0), alignment=2)
        b = c1.add_paragraph()
        spacing(b, after=0, line=1.0)
        runs(b, meta["family"], size=8.5, color=MUTED)
        # A header ends with a paragraph: the original one moves below the logo table, emptied.
        first = hdr.paragraphs[0]
        for r in list(first.runs):
            r._r.getparent().remove(r._r)
        hdr._element.remove(first._p)
        hdr._element.append(first._p)
        spacing(first, after=0, line=1.0)

        ftr = sec.footer
        ftr.is_linked_to_previous = False
        for p in list(ftr.paragraphs)[1:]:
            p._p.getparent().remove(p._p)
        # The letterhead's grey rule, as wide as on the letterhead, then the footer text on its own full-width line.
        rule = ftr.paragraphs[0]
        for r in list(rule.runs):
            r._r.getparent().remove(r._r)
        bdr = el("w:pBdr")
        bdr.append(el("w:bottom", **{"w:val": "single", "w:sz": "6", "w:color": "8F8F8F", "w:space": "1"}))
        rule._p.get_or_add_pPr().append(bdr)
        rule.paragraph_format.left_indent = rule.paragraph_format.right_indent = Inches(1.54)
        spacing(rule, after=4, line=1.0)
        rule.add_run().font.size = Pt(2)
        fp = ftr.add_paragraph()
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        spacing(fp, after=0, line=1.0)
        runs(fp, footer_line(meta), size=8.5, color=MUTED)
        fp2 = ftr.add_paragraph()
        fp2.alignment = WD_ALIGN_PARAGRAPH.CENTER
        runs(fp2, "Page ", size=8.5, color=MUTED)
        field(fp2, "PAGE")
        runs(fp2, " of ", size=8.5, color=MUTED)
        field(fp2, "NUMPAGES")

    # The brand cover, built here and moved to the front of the document.
    start = len(body)
    p = d.add_paragraph()
    spacing(p, before=40, after=8)
    runs(p, meta["coverFamily"].upper(), size=10, color=BLUE, bold=True)
    p = d.add_paragraph()
    spacing(p, after=6, line=1.0)
    runs(p, meta["title"], size=38, bold=True)
    p = d.add_paragraph()
    spacing(p, after=18)
    runs(p, meta["subtitle"], size=15, color=BLUE)
    p = d.add_paragraph()
    spacing(p, after=14, line=1.0)
    p.paragraph_format.right_indent = Inches(5.6)
    bar = el("w:pBdr")
    bar.append(el("w:bottom", **{"w:val": "single", "w:sz": "24", "w:color": BLUE, "w:space": "1"}))
    p._p.get_or_add_pPr().append(bar)
    t = d.add_table(rows=len(meta["meta"]), cols=2)
    t.autofit = False
    tb = el("w:tblBorders")
    for edge in ("top", "left", "right", "insideV"):
        tb.append(el(f"w:{edge}", **{"w:val": "nil"}))
    for edge in ("bottom", "insideH"):
        tb.append(el(f"w:{edge}", **{"w:val": "single", "w:sz": "4", "w:color": RULE}))
    t._tbl.tblPr.append(tb)
    for ri, (k, v) in enumerate(meta["meta"]):
        for ci, (val, col) in enumerate(((k, MUTED), (v, INK))):
            cell = t.cell(ri, ci)
            cell.width = Inches(1.4 if ci == 0 else 5.1)
            cp = cell.paragraphs[0]
            spacing(cp, before=2, after=2)
            internal_row = meta["internal"] and k == "Classification" and ci == 1
            runs(cp, val, size=9.5, color=BLUE if internal_row else col, bold=internal_row)
    p = d.add_paragraph()
    spacing(p, before=18, after=0)
    runs(p, meta["disclaimer"], size=8.5, color=MUTED)
    p.add_run().add_break(WD_BREAK.PAGE)
    cover = list(body)[start:]
    sect = body.find(qn("w:sectPr"))
    cover = [e for e in cover if e is not sect]
    for e in reversed(cover):
        body.remove(e)
        body.insert(0, e)

    embed_fonts(d)
    d.core_properties.title, d.core_properties.author, d.core_properties.subject = meta["title"], "IOTA", meta["kind"]
    d.save(out)
    os.remove(logo_png)


def embed_fonts(d):
    """Embeds IBM Plex Sans Condensed, Regular and Bold, so the document needs no installed font.

    Word's embedded-font format (ECMA-376 Part 1, 17.8.1): each TrueType file is stored obfuscated, its
    first 32 bytes XORed with a key taken from a GUID, and the font table names the part and the key.
    """
    import uuid

    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.opc.packuri import PackURI
    from docx.opc.part import Part
    from docx.oxml import parse_xml
    from docx.oxml.ns import qn

    table = next(r.target_part for r in d.part.rels.values() if r.reltype == RT.FONT_TABLE)
    root = parse_xml(table.blob)
    font = next((f for f in root.findall(qn("w:font")) if f.get(qn("w:name")) == FONT), None)
    if font is None:
        font = parse_xml(f'<w:font xmlns:w="{root.nsmap["w"]}" w:name="{FONT}"/>')
        root.append(font)
    for tag in ("w:embedRegular", "w:embedBold", "w:embedItalic", "w:embedBoldItalic"):
        for old in font.findall(qn(tag)):
            font.remove(old)
    for tag, face in (("w:embedRegular", "Regular"), ("w:embedBold", "Bold")):
        guid = uuid.uuid4()
        hexkey = guid.hex.upper()
        key = bytes(int(hexkey[i : i + 2], 16) for i in range(30, -1, -2))
        data = bytearray(open(os.path.join(BRAND, "fonts", f"IBMPlexSansCondensed-{face}.ttf"), "rb").read())
        for i in range(32):
            data[i] ^= key[i % 16]
        part = Part(
            PackURI(f"/word/fonts/plex-condensed-{face.lower()}.odttf"),
            "application/vnd.openxmlformats-officedocument.obfuscatedFont",
            bytes(data),
            d.part.package,
        )
        rid = table.relate_to(part, RT.FONT)
        e = parse_xml(
            f'<{tag} xmlns:w="{root.nsmap["w"]}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
            f' r:id="{rid}" w:fontKey="{{{str(guid).upper()}}}"/>'
        )
        font.append(e)
    from lxml import etree

    table._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    settings = d.settings.element
    if settings.find(qn("w:embedTrueTypeFonts")) is None:
        settings.insert(0, parse_xml(f'<w:embedTrueTypeFonts xmlns:w="{settings.nsmap["w"]}"/>'))


if __name__ == "__main__":
    mode, src, out, meta_path = sys.argv[1:5]
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    (brand_pdf if mode == "pdf" else brand_docx)(src, out, meta)
