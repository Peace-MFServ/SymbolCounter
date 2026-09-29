"""
The office's own cover and back page for a submittal pack.

The office uploads a PDF once: a pack sent before will do. Its first page is
kept as the cover and its last as the back page. For each job the cover's old
job text (the project, where it is, the contractor) is taken off and the job's
own is written in its place, in the same spot, size and colour. Words that
belong to the design stay: the title, the web address, labels such as
"Project:". Review marks left on the file (strike-outs, carets) are dropped.
"""
import re
from pathlib import Path

import pymupdf

from schedule_output import ASSETS_DIR

COVER_FILE = ASSETS_DIR / "submittal_cover.pdf"
_KEEP = re.compile(r"(submittal|ironmongery|technical|mfservices|www\.|@|^\s*\d[\d\s]{6,}$)", re.I)
_LABEL = re.compile(r":\s*$")


def saved() -> dict:
    if not COVER_FILE.exists():
        return {"cover": False, "back": False}
    with pymupdf.open(COVER_FILE) as d:
        return {"cover": True, "back": len(d) > 1, "updated": COVER_FILE.stat().st_mtime}


def save(data: bytes) -> dict:
    """Keep the first page as the cover and, if there is more than one, the last as the back."""
    src = pymupdf.open(stream=data, filetype="pdf")
    if len(src) == 0:
        raise ValueError("That PDF has no pages")
    out = pymupdf.open()
    out.insert_pdf(src, from_page=0, to_page=0)
    if len(src) > 1:
        out.insert_pdf(src, from_page=len(src) - 1, to_page=len(src) - 1)
    for pg in out:
        for a in list(pg.annots()):
            pg.delete_annot(a)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    out.save(COVER_FILE, garbage=3, deflate=True)
    return saved()


def _rgb(c: int) -> tuple:
    return ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255


def _fit(text: str, size: float, room: float) -> float:
    while size > 7 and pymupdf.get_text_length(text, "helv", size) > room:
        size -= 0.5
    return size


def fill(project: str, site: str, contractor: str) -> pymupdf.Document:
    """The cover with this job on it, and the back page, as a two-page (or one-page) document."""
    doc = pymupdf.open(COVER_FILE)
    pg = doc[0]
    W = pg.rect.width
    spans = [s for b in pg.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"] if s["text"].strip()]
    labels = [s for s in spans if _LABEL.search(s["text"]) and len(s["text"].strip()) <= 20]
    old = [s for s in spans if s not in labels and not _KEEP.search(s["text"])]
    lines = [pymupdf.Rect(dr["rect"]) for dr in pg.get_drawings()
             if dr["rect"].height < 2.5 and dr["rect"].width > 10]

    # take the old job's words off, and the rule under each
    underlined = False
    for s in old:
        r = pymupdf.Rect(s["bbox"])
        pg.add_redact_annot(r, fill=False)
        for ln in lines:
            if s["origin"][1] - 1 <= ln.y0 <= r.y1 + 6 and ln.x0 < r.x1 and ln.x1 > r.x0:
                pg.add_redact_annot(ln + (-1, -1.5, 1, 1.5), fill=False); underlined = True
    pg.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                        graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                        text=pymupdf.PDF_REDACT_TEXT_REMOVE)

    def put(x, y, text, size, colour, rule=False):
        size = _fit(text, size, W - x - 36)
        pg.insert_text((x, y), text, fontname="helv", fontsize=size, color=colour)
        if rule:
            w = pymupdf.get_text_length(text, "helv", size)
            pg.draw_line((x, y + size * 0.15), (x + w, y + size * 0.15), color=colour, width=0.6)

    by_label = {}
    for lb in labels:
        key = lb["text"].strip().rstrip(":").lower()
        by_label[key] = lb
    if by_label:
        # "Project:  …" / "Contractor:  …": each answer after its label
        answers = {"project": project, "contractor": contractor or "", "client": contractor or "",
                   "site": site or "", "location": site or "", "address": site or ""}
        for key, lb in by_label.items():
            val = answers.get(key)
            if not val:
                continue
            same = [s for s in old if abs(s["origin"][1] - lb["origin"][1]) < 3]
            colour = _rgb(same[0]["color"]) if same else (0, 0, 0)
            size = same[0]["size"] if same else lb["size"] - 2
            put(lb["bbox"][2] + 6, lb["origin"][1], val, size, colour)
    else:
        # the job written as lines, one under another, where the old ones were
        if old:
            first = min(old, key=lambda s: s["origin"][1])
            ys = sorted({round(s["origin"][1], 1) for s in old})
            pitch = min((b - a for a, b in zip(ys, ys[1:]) if b - a > 4), default=first["size"] * 2.2)
            x, y, size, colour = first["bbox"][0], first["origin"][1], first["size"], _rgb(first["color"])
        else:
            x, y, size, colour, pitch = 72, pg.rect.height * 0.55, 12, (0.15, 0.2, 0.33), 26
        for text in [t for t in (project, site, contractor) if t]:
            put(x, y, text, size, colour, rule=underlined)
            y += pitch
    return doc
