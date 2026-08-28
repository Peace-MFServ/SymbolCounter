"""
Legend template harvesting.

The legend block on a drawing is the one place the drawing firm provides a
clean, isolated, canonical example of every symbol — right beside a text
label naming it. This module crops those glyphs and maps the label text to
our symbol codes, turning every uploaded drawing into a source of
high-quality templates without anyone snipping by hand.

Pipeline per page:
  1. find_legend_region() locates the legend bbox from the PDF text layer.
  2. Words inside it are clustered into label segments (rows, split on
     column gaps).
  3. Each segment's text is matched against symbol-code aliases.
  4. The glyph cell immediately LEFT of a matched label is cropped from the
     rendered page image, trimmed to its ink content, and quality-filtered.
"""

import cv2
import numpy as np
import logging
import os
import re

from .pipeline import parse_pdf_page_text, find_legend_region, _word_box

logger = logging.getLogger(__name__)

# Alias token sets per symbol code: a label matches a code when every token
# of at least one alias appears in the label. Extend as firms' wording varies.
CODE_ALIASES = {
    "CCTV_Fixed": [["FIXED", "CCTV"], ["FIXED", "CAMERA"]],
    "CCTV_Dome":  [["DOME", "CCTV"], ["DOME", "CAMERA"], ["STATIC", "DOME"]],
    "AIS":        [["AUDIO", "INTERCOM"], ["INTERCOM", "SYSTEM"], ["INTERCOM"]],
    "AC":         [["ACCESS", "CONTROL"]],
    "I/O":        [["INPUT", "OUTPUT"]],
}

_TOKEN_RE = re.compile(r"[A-Z0-9/]+")


def _tokens(text: str) -> set:
    return set(_TOKEN_RE.findall(text.upper()))


def match_label_to_code(label: str, aliases: dict = None) -> str | None:
    """Return the symbol code a legend label describes, or None."""
    toks = _tokens(label)
    if not toks:
        return None
    hits = []
    for code, alias_lists in (aliases or CODE_ALIASES).items():
        if any(set(a) <= toks for a in alias_lists):
            hits.append(code)
    # Ambiguous labels (e.g. matching two codes) are safer skipped
    return hits[0] if len(hits) == 1 else None


def _label_segments(words, page_dims, legend_bbox):
    """
    Group legend words into label segments: cluster by row (y-centre), then
    split each row where the x-gap between consecutive words jumps — that's
    a column boundary in a multi-column legend.
    Yields (text, x1, y1, x2, y2) in normalised page coordinates.
    """
    pw, ph = page_dims
    lx1, ly1, lx2, ly2 = legend_bbox

    inside = []
    for w in words:
        bx1, by1, bx2, by2 = _word_box(w)
        x1, y1, x2, y2 = bx1 / pw, by1 / ph, bx2 / pw, by2 / ph
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        if lx1 <= cx <= lx2 and ly1 <= cy <= ly2 and (w.text or "").strip():
            inside.append(((w.text or "").strip(), x1, y1, x2, y2, cy))
    if not inside:
        return

    heights = sorted(b[4] - b[2] for b in inside)
    line_h = heights[len(heights) // 2] or 0.008

    inside.sort(key=lambda b: b[5])
    rows, current = [], [inside[0]]
    for b in inside[1:]:
        if abs(b[5] - current[-1][5]) <= line_h * 0.7:
            current.append(b)
        else:
            rows.append(current)
            current = [b]
    rows.append(current)

    COL_GAP = 0.025
    for row in rows:
        row.sort(key=lambda b: b[1])
        seg = [row[0]]
        for b in row[1:]:
            if b[1] - seg[-1][3] > COL_GAP:
                yield _segment_tuple(seg)
                seg = [b]
            else:
                seg.append(b)
        yield _segment_tuple(seg)


def _segment_tuple(seg):
    text = " ".join(b[0] for b in seg)
    return (text,
            min(b[1] for b in seg), min(b[2] for b in seg),
            max(b[3] for b in seg), max(b[4] for b in seg))


def _trim_to_ink(crop: np.ndarray, band: tuple = None, pad: int = 5):
    """
    Tighten a crop to its dark content; None if there is no real content.

    `band` is an optional (y1, y2) pixel range inside the crop marking the
    label row's own vertical band. When given, only connected ink components
    that overlap the band are kept — this drops bleed from neighbouring
    legend rows (labels above/below) and stray table border lines.
    """
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    mask = (gray < 200).astype(np.uint8)
    if not mask.any():
        return None

    if band is not None:
        by1, by2 = band
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        keep = np.zeros_like(mask)
        for i in range(1, n):
            top    = stats[i, cv2.CC_STAT_TOP]
            bottom = top + stats[i, cv2.CC_STAT_HEIGHT]
            if bottom >= by1 and top <= by2:
                keep[labels == i] = 1
        if keep.any():
            mask = keep

    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    x1, x2 = xs.min(), xs.max() + 1
    y1, y2 = ys.min(), ys.max() + 1
    x1 = max(0, x1 - pad); y1 = max(0, y1 - pad)
    x2 = min(crop.shape[1], x2 + pad); y2 = min(crop.shape[0], y2 + pad)
    return crop[y1:y2, x1:x2]


def harvest_legend_templates(pdf_path: str, page_image_path: str,
                             page_num: int = 1, aliases: dict = None) -> list[dict]:
    """
    Harvest symbol templates from one page's legend.
    Returns [{code, label, image (BGR np.ndarray)}], possibly empty.
    """
    words, page_dims = parse_pdf_page_text(pdf_path, page_num)
    legend_bbox = find_legend_region(words, page_dims)
    if not legend_bbox:
        return []

    img = cv2.imread(page_image_path)
    if img is None:
        logger.warning("Legend harvest: cannot read %s", page_image_path)
        return []
    H, W = img.shape[:2]

    results = []
    for label, sx1, sy1, sx2, sy2 in _label_segments(words, page_dims, legend_bbox):
        code = match_label_to_code(label, aliases)
        if not code:
            continue

        # Glyph cell: the symbol sits somewhere left of its label. Take a
        # generous window (symbols often embed their own code text — that
        # text is part of the symbol as drawn on the plan, so keep it) and
        # let the ink-trim tighten to actual content.
        line_h = (sy2 - sy1) or 0.008
        gy1 = max(0.0, sy1 - line_h * 1.8)
        gy2 = min(1.0, sy2 + line_h * 1.8)
        gx2 = max(0.0, sx1 - 0.001)                       # just short of the text
        gx1 = max(0.0, gx2 - max(0.045, line_h * 8.0))    # wide enough for the glyph column

        crop = img[int(gy1 * H):int(gy2 * H), int(gx1 * W):int(gx2 * W)]
        if crop.size == 0:
            continue
        # Label row's own band, in crop-local pixels, slightly expanded —
        # ink components outside it are neighbouring rows, not this symbol
        band = (int((sy1 - line_h * 0.4 - gy1) * H), int((sy2 + line_h * 0.4 - gy1) * H))
        crop = _trim_to_ink(crop, band=band)
        if crop is None:
            continue

        h, w = crop.shape[:2]
        ink = float((cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) < 200).mean())
        # Quality gate: too small = noise; too much ink = grabbed a text block
        if h < 18 or w < 18 or not (0.005 <= ink <= 0.6) or max(h, w) > 420:
            logger.debug("Legend harvest: rejected %s crop %dx%d ink=%.2f (%r)",
                         code, w, h, ink, label)
            continue

        results.append({"code": code, "label": label, "image": crop})

    if results:
        logger.info("Legend harvest: %d templates from %s page %d (%s)",
                    len(results), os.path.basename(pdf_path), page_num,
                    ", ".join(r["code"] for r in results))
    return results


def _norm64(image: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    return cv2.resize(g, (64, 64)).astype(np.float32)


def _sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(cv2.matchTemplate(a, b, cv2.TM_CCOEFF_NORMED)[0, 0])


def select_representative_templates(crops: list[dict], max_per_code: int = 4,
                                    outlier_median: float = 0.45,
                                    dup_thresh: float = 0.93) -> list[dict]:
    """
    Reduce a pile of harvested crops to a clean library per symbol code:
      - outlier rejection: a crop must resemble the majority of crops
        harvested for the same code (median pairwise similarity), which
        discards mis-crops like table borders grabbed instead of a glyph;
      - dedupe: near-identical survivors collapse to one, largest first;
      - cap at max_per_code.
    """
    by_code: dict[str, list] = {}
    for c in crops:
        by_code.setdefault(c["code"], []).append(c)

    out = []
    for code, items in by_code.items():
        if len(items) >= 3:
            norm = [_norm64(c["image"]) for c in items]
            n = len(items)
            med = []
            for i in range(n):
                sims = [_sim(norm[i], norm[j]) for j in range(n) if j != i]
                med.append(float(np.median(sims)))
            kept = [items[i] for i in range(n) if med[i] >= outlier_median]
            dropped = n - len(kept)
            if dropped:
                logger.info("Legend harvest: dropped %d outlier %s crop(s)", dropped, code)
            items = kept or [items[int(np.argmax(med))]]

        items.sort(key=lambda c: -(c["image"].shape[0] * c["image"].shape[1]))
        sel = []
        for c in items:
            g = _norm64(c["image"])
            if all(_sim(g, _norm64(s["image"])) < dup_thresh for s in sel):
                sel.append(c)
            if len(sel) >= max_per_code:
                break
        out.extend(sel)
    return out
