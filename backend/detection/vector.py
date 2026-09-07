"""
Vector-native symbol detection.

CAD-exported PDFs describe every symbol as geometry: the same device is the
same set of path commands wherever it appears. Instead of rasterising the
sheet and recognising blurry pixels, this engine:

  1. reads the page's vector paths and text with PyMuPDF,
  2. drops the building background (light-grey linework) so only the
     services layers remain,
  3. parses the legend from geometry — each legend row's glyph (paths +
     any text inside it) becomes a signature keyed to its label,
  4. finds every plan glyph with the same primary shape, colour, inner text
     and adornments as a legend signature.

Coordinates are normalised to the page (0-1), matching the raster
pipeline's imgX/imgY convention, so the verify canvas needs no changes.
"""

import collections
import logging
import math
import re

logger = logging.getLogger(__name__)

try:
    import pymupdf as fitz
except ImportError:  # older installs expose the module as fitz
    import fitz

# Symbol-sized paths: anything larger is walls, cable runs, or the sheet frame
MIN_SYMBOL_PT = 3.0
MAX_SYMBOL_PT = 45.0
ADORN_REACH   = 0.9      # adornments are within this × the anchor's size
GRID          = 0.1      # shape normalisation grid (fraction of bbox)
_TOKEN_RE     = re.compile(r"[A-Z0-9/]+")


# ── Geometry helpers ──────────────────────────────────────────────────────────
def _is_background(color) -> bool:
    """Light, unsaturated strokes/fills are the architect's base drawing."""
    if color is None:
        return True
    return (max(color) - min(color)) < 0.12 and min(color) > 0.55


def _colour_key(d) -> str:
    c = d.get("color") or d.get("fill") or (0, 0, 0)
    r, g, b = (round(v * 4) / 4 for v in c)   # coarse bins: red/blue/black/...
    return f"{r:.2f},{g:.2f},{b:.2f}"


def _shape_points(d):
    """Path endpoints normalised to the path bbox, snapped to a coarse grid."""
    r = d["rect"]
    w, h = max(r.width, 0.1), max(r.height, 0.1)
    pts = set()
    for it in d["items"]:
        for p in it[1:]:
            if hasattr(p, "x"):
                pts.add((round((p.x - r.x0) / w / GRID) * GRID, round((p.y - r.y0) / h / GRID) * GRID))
            elif hasattr(p, "x0"):   # 're' items carry a Rect
                pts.update({(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)})
    return frozenset((round(x, 1), round(y, 1)) for x, y in pts)


def _rot_variants(pts):
    """The same shape under 90° rotations and mirroring."""
    out = set()
    for fx in (False, True):
        for k in range(4):
            cur = set()
            for x, y in pts:
                if fx:
                    x = 1.0 - x
                for _ in range(k):
                    x, y = 1.0 - y, x
                cur.add((round(x, 1), round(y, 1)))
            out.add(frozenset(cur))
    return out


def _seg_kinds(d) -> str:
    return "".join(sorted(it[0] for it in d["items"]))


def _aspect(d) -> float:
    r = d["rect"]
    return round(r.width / max(r.height, 0.1), 1)


def _length_profile(d) -> tuple:
    """
    Rotation-invariant fallback descriptor for line-built symbols (cameras
    are rotated to arbitrary angles on plans): the segment lengths sorted and
    normalised by the longest.
    """
    lens = []
    for it in d["items"]:
        if it[0] == "l":
            lens.append(math.hypot(it[2].x - it[1].x, it[2].y - it[1].y))
        elif it[0] == "c":
            lens.append(math.hypot(it[4].x - it[1].x, it[4].y - it[1].y))
        elif it[0] in ("re", "qu"):
            r = it[1]
            lens.extend([r.width, r.height] if hasattr(r, "width") else [1.0, 1.0])
    if not lens:
        return ()
    m = max(lens) or 1.0
    return tuple(sorted(round(l / m, 1) for l in lens))


def find_legend_box(vp, fallback_rect=None):
    """
    The legend on CAD sheets is drawn inside a border box. Take the smallest
    rectangle-like path that contains the word LEGEND and is not most of the
    page; fall back to the caller's region estimate.
    """
    legend_words = [w for w in vp.words if w[4].strip().upper().rstrip(":") == "LEGEND"]
    if not legend_words:
        return fallback_rect
    lw = legend_words[0]
    lp = fitz.Point((lw[0] + lw[2]) / 2, (lw[1] + lw[3]) / 2)
    page_area = vp.width * vp.height
    best = None
    for d in vp.page.get_drawings():
        kinds = _seg_kinds(d)
        if kinds not in ("re", "qu", "llll") and not (set(kinds) == {"l"} and len(d["items"]) >= 4):
            continue
        r = d["rect"]
        area = r.width * r.height
        if area < 0.005 * page_area or area > 0.5 * page_area:
            continue
        if not r.contains(lp):
            continue
        if best is None or area < best.width * best.height:
            best = fitz.Rect(r)
    return best or fallback_rect


def _is_shape(d) -> bool:
    """
    A symbol anchor is a real shape — curves, rectangles, or a multi-segment
    polyline of sane proportions. Bare lines (row separators, leaders, wire
    stubs) can never anchor a symbol: a legend row anchored to its separator
    line once 'matched' every dashed leader and title-block edge on the sheet.
    """
    kinds = _seg_kinds(d)
    r = d["rect"]
    asp = r.width / max(r.height, 0.1)
    if asp > 6 or asp < 1 / 6:
        return False
    if set(kinds) == {"l"}:
        return len(d["items"]) >= 3
    return True


class Glyph:
    """
    A symbol candidate: an anchor path plus adornments, the text inside the
    anchor, and short qualifier tokens beside it (e.g. the 'CV' that turns a
    Smoke Detector into its ceiling-void variant).
    """
    __slots__ = ("anchor", "adorns", "text", "near", "rect", "colour")

    def __init__(self, anchor, adorns, text, near, colour):
        self.anchor = anchor
        self.adorns = adorns
        self.text = text
        self.near = near
        self.colour = colour
        r = fitz.Rect(anchor["rect"])
        for a in adorns:
            r |= a["rect"]
        self.rect = r


def _adorn_key(anchor, a):
    """Adornment shape + where it sits relative to the anchor (coarse)."""
    ar, r = anchor["rect"], a["rect"]
    cx = (r.x0 + r.x1) / 2 - (ar.x0 + ar.x1) / 2
    cy = (r.y0 + r.y1) / 2 - (ar.y0 + ar.y1) / 2
    s = max(ar.width, ar.height, 0.1)
    return (_seg_kinds(a), round(cx / s * 2) / 2, round(cy / s * 2) / 2)


# ── Page analysis ─────────────────────────────────────────────────────────────
class VectorPage:
    def __init__(self, page):
        self.page = page
        self.width, self.height = page.rect.width, page.rect.height
        self.words = page.get_text("words")     # x0, y0, x1, y1, text, ...
        drawings = page.get_drawings()
        self.n_paths = len(drawings)
        self.n_images = len(page.get_images())
        self.paths = [
            d for d in drawings
            if not _is_background(d.get("color") or d.get("fill"))
            and MIN_SYMBOL_PT <= max(d["rect"].width, d["rect"].height) <= MAX_SYMBOL_PT
            and d["items"]
        ]

    @property
    def is_vector(self) -> bool:
        """Enough real geometry to trust — scans have few paths and one big image."""
        return self.n_paths >= 200 and self.n_images <= 5

    def inner_text(self, rect) -> str:
        r = fitz.Rect(rect) + (-1, -1, 1, 1)
        toks = [w[4].upper() for w in self.words
                if r.x0 <= (w[0] + w[2]) / 2 <= r.x1 and r.y0 <= (w[1] + w[3]) / 2 <= r.y1]
        return " ".join(sorted(toks))

    def near_tokens(self, anchor_rect, zone, band=None) -> frozenset:
        """Short qualifier tokens beside the anchor (CV, 4NO...), not inside it."""
        inner = fitz.Rect(anchor_rect) + (-1, -1, 1, 1)
        out = set()
        for w in self.words:
            cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
            if not zone.contains(fitz.Point(cx, cy)) or inner.contains(fitz.Point(cx, cy)):
                continue
            if band and not (band[0] <= cy <= band[1]):
                continue
            t = w[4].upper()
            if 1 <= len(t) <= 4 and _TOKEN_RE.fullmatch(t):
                out.add(t)
        return frozenset(out)

    def label_right(self, rect, row_cy, x_limit, y_stop=None) -> str:
        """
        The legend label for a glyph: words on the same row, right of the
        glyph, up to the legend's right edge. Stops at the first wide gap so
        a second legend column can't bleed into the label. A long label that
        wraps onto a second line (left-aligned under the first word, above
        the next legend row at `y_stop`) is read as one label.
        """
        def line_at(cy, x_min):
            row = sorted(
                [w for w in self.words
                 if w[0] > x_min and w[0] < x_limit and abs((w[1] + w[3]) / 2 - cy) < 5],
                key=lambda w: w[0])
            out = []
            for w in row:
                if out and w[0] - out[-1][2] > 30:
                    break
                out.append(w)
            return out

        out = line_at(row_cy, rect.x1 + 1)
        if out and y_stop is not None:
            first = out[0]
            line_h = max(first[3] - first[1], 4.0)
            below = [w for w in self.words
                     if abs(w[0] - first[0]) < 6 and w[1] > first[3] - 1
                     and w[1] < first[3] + 1.2 * line_h
                     and (w[1] + w[3]) / 2 < y_stop and w[0] < x_limit]
            if below:
                b = min(below, key=lambda w: w[1])
                out += line_at((b[1] + b[3]) / 2, b[0] - 1)
        return " ".join(w[4] for w in out)

    def glyph_at(self, anchor, exclude=(), band=None) -> Glyph:
        """
        Assemble a glyph around an anchor path: small nearby paths + text.
        `band` (y0, y1) restricts adornments to a legend row so neighbouring
        rows can't leak in.
        """
        ar = anchor["rect"]
        size = max(ar.width, ar.height)
        reach = size * ADORN_REACH
        zone = fitz.Rect(ar.x0 - reach, ar.y0 - reach, ar.x1 + reach, ar.y1 + reach)
        adorns = []
        for p in self.paths:
            if p is anchor or id(p) in exclude:
                continue
            pr = p["rect"]
            cx, cy = (pr.x0 + pr.x1) / 2, (pr.y0 + pr.y1) / 2
            if not zone.contains(fitz.Point(cx, cy)):
                continue
            if max(pr.width, pr.height) > size * 1.0:
                continue
            if band and not (band[0] <= cy <= band[1]):
                continue
            adorns.append(p)
        return Glyph(anchor, adorns, self.inner_text(ar),
                     self.near_tokens(ar, zone, band), _colour_key(anchor))


# ── Signatures ────────────────────────────────────────────────────────────────
class Signature:
    __slots__ = ("label", "glyph", "shape_variants", "length_profile", "kinds", "aspect",
                 "colour", "text", "near", "adorns", "size")

    def __init__(self, label: str, glyph: Glyph):
        self.label = label
        self.glyph = glyph
        self.shape_variants = _rot_variants(_shape_points(glyph.anchor))
        self.length_profile = _length_profile(glyph.anchor)
        self.kinds = _seg_kinds(glyph.anchor)
        self.aspect = _aspect(glyph.anchor)
        self.colour = glyph.colour
        self.text = glyph.text
        self.near = glyph.near
        self.adorns = collections.Counter(_adorn_key(glyph.anchor, a) for a in glyph.adorns)
        self.size = max(glyph.anchor["rect"].width, glyph.anchor["rect"].height)

    def score(self, glyph: Glyph):
        """0..1 match quality, or None if the anchor is a different shape."""
        a = glyph.anchor
        if _seg_kinds(a) != self.kinds:
            return None
        if _colour_key(a) != self.colour:
            return None
        pts = _shape_points(a)
        if pts in self.shape_variants:
            shape_s = 1.0
        else:
            # tolerate tiny tessellation differences via Jaccard on the best variant
            best = max((len(pts & v) / max(len(pts | v), 1) for v in self.shape_variants), default=0)
            if best >= 0.8:
                shape_s = best
            elif _length_profile(a) == self.length_profile:
                shape_s = 0.9    # same construction, arbitrary rotation (cameras)
            else:
                return None
        text_s = 1.0 if glyph.text == self.text else 0.0
        g_ad = collections.Counter(_adorn_key(a, x) for x in glyph.adorns)
        if not self.adorns and not g_ad:
            ad_s = 1.0
        else:
            inter = sum((self.adorns & g_ad).values())
            union = sum((self.adorns | g_ad).values())
            ad_s = inter / max(union, 1)
        # Qualifier text beside the symbol: the legend's qualifiers must all be
        # present; extra tokens on the plan (annotations) cost only a little.
        if self.near <= glyph.near:
            near_s = 1.0 if glyph.near == self.near else 0.7
        else:
            near_s = 0.0
        return 0.40 * shape_s + 0.30 * text_s + 0.18 * ad_s + 0.12 * near_s


def parse_legend(vp: VectorPage, legend_rect) -> list[Signature]:
    """
    Build one signature per legend row. The row's anchor is the largest path
    in the glyph cell; its label is the text to the right on the same row.
    """
    lr = fitz.Rect(legend_rect)
    in_legend = [p for p in vp.paths
                 if _is_shape(p) and lr.contains(fitz.Point((p["rect"].x0 + p["rect"].x1) / 2,
                                                            (p["rect"].y0 + p["rect"].y1) / 2))]
    # Legends run in one or more columns of rows. Cluster shapes into columns
    # by x-centre first (a six-column legend otherwise collapses into one
    # glyph per y-line), then into rows by y-centre within each column.
    columns: list[list] = []
    for p in sorted(in_legend, key=lambda p: (p["rect"].x0 + p["rect"].x1) / 2):
        cx = (p["rect"].x0 + p["rect"].x1) / 2
        if columns and cx - columns[-1][-1] < 25.0:
            columns[-1][0].append(p)
            columns[-1][-1] = cx
        else:
            columns.append([[p], cx])

    rows: list[tuple] = []      # (paths, row_cy, half_band, column_right_limit)
    for ci, (cpaths, _) in enumerate(columns):
        col_rows: list[list] = []
        for p in sorted(cpaths, key=lambda p: (p["rect"].y0 + p["rect"].y1) / 2):
            cy = (p["rect"].y0 + p["rect"].y1) / 2
            if col_rows and abs(cy - col_rows[-1][-1]) < 4.0:
                col_rows[-1][0].append(p)
                col_rows[-1][-1] = cy
            else:
                col_rows.append([[p], cy])
        # Row band: reach qualifier text hanging below a glyph without
        # touching the neighbouring rows
        pitches = [b[-1] - a[-1] for a, b in zip(col_rows, col_rows[1:])]
        pitch = sorted(pitches)[len(pitches) // 2] if pitches else 20.0
        half = min(9.0, max(4.5, pitch * 0.45))
        next_col_x = columns[ci + 1][1] - 30 if ci + 1 < len(columns) else lr.x1
        for ri, (paths, cy) in enumerate(col_rows):
            y_stop = col_rows[ri + 1][-1] - half if ri + 1 < len(col_rows) else lr.y1
            rows.append((paths, cy, half, next_col_x, y_stop))

    sigs = []
    seen_labels = set()
    for paths, row_cy, half, x_limit, y_stop in rows:
        anchor = max(paths, key=lambda p: p["rect"].width * p["rect"].height)
        glyph = vp.glyph_at(anchor, band=(row_cy - half, row_cy + half))
        label = vp.label_right(glyph.rect, row_cy, x_limit, y_stop)
        label = re.sub(r"\s+", " ", label).strip()
        if len(_TOKEN_RE.findall(label.upper())) < 2:
            continue
        if label in seen_labels:
            continue
        seen_labels.add(label)
        sigs.append(Signature(label, glyph))
    return sigs


def legend_self_consistency(sigs: list[Signature]) -> list[tuple]:
    """
    Every legend glyph must match its own signature best. Returns the
    (label, confused_with) pairs that don't — the legend rows the engine
    cannot tell apart, which is exactly where counts would be wrong.
    """
    problems = []
    for s in sigs:
        best, best_s = None, -1.0
        for t in sigs:
            sc = t.score(s.glyph)
            if sc is not None and sc > best_s:
                best, best_s = t, sc
        if best is not s and (best is None or best.label != s.label):
            problems.append((s.label, best.label if best else None))
    return problems


def detect_page(vp: VectorPage, sigs: list[Signature], legend_rect, min_score: float = 0.75):
    """
    Match every plan anchor against the legend signatures.
    Returns [{label, x, y (normalised), confidence}] outside the legend.
    """
    lr = fitz.Rect(legend_rect) if legend_rect else None
    claimed: set[int] = set()
    results = []
    # Larger anchors first so a composite symbol claims its parts before a
    # small part is considered as its own symbol.
    for p in sorted(vp.paths, key=lambda p: -(p["rect"].width * p["rect"].height)):
        if id(p) in claimed or not _is_shape(p):
            continue
        c = fitz.Point((p["rect"].x0 + p["rect"].x1) / 2, (p["rect"].y0 + p["rect"].y1) / 2)
        if lr and lr.contains(c):
            continue
        glyph = vp.glyph_at(p, exclude=claimed)
        best, best_s = None, 0.0
        for s in sigs:
            sc = s.score(glyph)
            if sc is not None and sc > best_s:
                best, best_s = s, sc
        if best and best_s >= min_score:
            claimed.add(id(p))
            claimed.update(id(a) for a in glyph.adorns)
            results.append({
                "label": best.label,
                "x": c.x / vp.width, "y": c.y / vp.height,
                "confidence": round(best_s, 3),
            })
    return results


def run_vector_detection(pdf_path: str, page_num: int, legend_bbox_norm) -> dict:
    """
    Entry point for one page. `legend_bbox_norm` is the (x1,y1,x2,y2) region
    in normalised coordinates from pipeline.find_legend_region, or None.
    Returns {"is_vector": bool, "legend": [labels], "detections": [...]}.
    """
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_num - 1]
        vp = VectorPage(page)
        if not vp.is_vector:
            return {"is_vector": False, "legend": [], "detections": []}
        fallback = None
        if legend_bbox_norm:
            x1, y1, x2, y2 = legend_bbox_norm
            fallback = fitz.Rect(x1 * vp.width, y1 * vp.height, x2 * vp.width, y2 * vp.height)
        legend_rect = find_legend_box(vp, fallback)
        sigs = parse_legend(vp, legend_rect) if legend_rect else []
        dets = detect_page(vp, sigs, legend_rect) if sigs else []
        logger.info("Vector detection page %d: %d paths kept, %d legend signatures, %d detections",
                    page_num, len(vp.paths), len(sigs), len(dets))
        return {"is_vector": True, "legend": [s.label for s in sigs], "detections": dets}
    finally:
        doc.close()
