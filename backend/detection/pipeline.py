"""
Symbol detection pipeline — v3

Fixes vs v2:
  - Stale page image bug fixed (img variable scoped per loop iteration)
  - text_fallback detections spread across page instead of all at (0.5, 0.4)
  - Scale pyramid extended to 0.6x–1.4x for better size variance coverage
  - 4-rotation support per template (0°, 90°, 180°, 270°)
  - Firm-scoped template prioritisation (project firm templates ranked first)
  - pdftotext called once per page (bbox XML parsed for both text and door refs)
  - subprocess timeout added to pdftoppm
  - ET.ParseError caught explicitly, other exceptions logged not swallowed
  - `or` idiom on ET.find replaced with explicit is None checks
  - text_fallback detections excluded from dedup (spread grid positions)
"""

import cv2
import numpy as np
import subprocess
import re
import os
import logging
from pathlib import Path
from xml.etree import ElementTree as ET
from typing import Optional

logger = logging.getLogger(__name__)

LEGEND_X_CUTOFF = 0.22   # exclude legend area (left side)
TITLE_Y_CUTOFF  = 0.85   # exclude title block (bottom)

# Scale pyramid: ±50% in steps (extended range handles more drawing scale variation)
DEFAULT_SCALE_RANGE = np.arange(0.50, 1.51, 0.10)
# Rotation angles (degrees): 0 is the snipped orientation; add 90/180/270 for rotated symbols
ROTATION_ANGLES = [0, 90, 180, 270]

DEFAULT_TEXT_CODES = ["AIS", "AC", "I/O", "S", "H", "FARP", "FAP"]

# Safety cap: if template matching finds more than this many hits for a single
# symbol code on one page the template is almost certainly too generic.
# The top-N by confidence are kept; a warning is logged.
MAX_DETECTIONS_PER_CODE = 40


# ── Helpers ───────────────────────────────────────────────────────────────────
def _rotate_image(img: np.ndarray, angle: int) -> np.ndarray:
    """Rotate image by angle degrees (0, 90, 180, 270 only)."""
    if angle == 0:
        return img
    elif angle == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    elif angle == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    elif angle == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


# ── PDF rendering ─────────────────────────────────────────────────────────────
def render_pdf_pages(pdf_path: str, output_dir: str, dpi: int = 200) -> list[str]:
    os.makedirs(output_dir, exist_ok=True)
    base = os.path.join(output_dir, "page")
    try:
        subprocess.run(
            ["pdftoppm", "-r", str(dpi), "-png", pdf_path, base],
            check=True, capture_output=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("PDF rendering timed out — file may be too large")
    except FileNotFoundError:
        raise RuntimeError(
            "Poppler (pdftoppm) is not installed or not on PATH — "
            "install it with 'winget install poppler' and restart the backend"
        )
    pages = sorted(Path(output_dir).glob("page-*.png"))
    if not pages:
        pages = sorted(Path(output_dir).glob("page*.png"))
    return [str(p) for p in pages]


# ── Template loading ──────────────────────────────────────────────────────────
def load_templates(template_records: list, drawing_firm: str = "") -> dict[str, list[dict]]:
    """
    Load template images from disk, sorted by firm match then quality score.
    Returns {symbol_code: [{image, threshold, template_id, quality_score, firm_match}, ...]}
    """
    by_code: dict[str, list] = {}
    firm_lower = (drawing_firm or "").lower().strip()

    for rec in template_records:
        if not os.path.exists(rec.image_path):
            continue
        img = cv2.imread(rec.image_path, cv2.IMREAD_GRAYSCALE)
        if img is None or img.size == 0:
            continue
        code = rec.symbol_code
        if code not in by_code:
            by_code[code] = []
        firm_match = bool(firm_lower and firm_lower in (rec.drawing_firm or "").lower())
        by_code[code].append({
            "image":         img,
            "threshold":     rec.effective_threshold,
            "template_id":   rec.id,
            "quality_score": rec.quality_score,
            "firm_match":    firm_match,
        })

    # Sort: firm-matched templates first, then by quality score descending
    for code in by_code:
        by_code[code].sort(key=lambda t: (not t["firm_match"], -t["quality_score"]))

    return by_code


# ── Template matching ─────────────────────────────────────────────────────────
def match_templates_on_page(
    search_gray: np.ndarray,
    search_h: int,
    search_w: int,
    x_offset: int,
    full_img_w: int,
    full_img_h: int,
    templates_by_code: dict[str, list[dict]],
    scale_range=None,
    use_rotations: bool = True,
) -> list[dict]:
    """
    Run multi-template matching for all symbol codes.
    Applies scale pyramid and optional 4-rotation variants.
    Uses per-template adaptive thresholds and NMS.
    """
    if scale_range is None:
        scale_range = DEFAULT_SCALE_RANGE

    detections = []

    for code, tmpl_list in templates_by_code.items():
        candidates = []
        for tmpl in tmpl_list[:8]:  # cap at 8 templates per code
            base_img = tmpl["image"]
            thresh   = tmpl["threshold"]

            angles = ROTATION_ANGLES if use_rotations else [0]

            for angle in angles:
                img = _rotate_image(base_img, angle)
                th, tw = img.shape

                for scale in scale_range:
                    rw, rh = int(tw * scale), int(th * scale)
                    # Minimum size: reject templates smaller than 20×20 at this scale —
                    # tiny templates match partial features everywhere (false positives).
                    if rw > search_w or rh > search_h or rw < 20 or rh < 20:
                        continue
                    resized = cv2.resize(img, (rw, rh))
                    # NOTE on masked matching: a previous version used a binary
                    # mask with TM_CCORR_NORMED to ignore white background. That
                    # over-detected badly — CCORR_NORMED (no mean subtraction)
                    # scores ~0.85-0.95 nearly everywhere on white-background
                    # drawings, so thresholds calibrated for TM_CCOEFF_NORMED
                    # (0.55-0.82 adaptive range, manual overrides, legend 0.65)
                    # became far too permissive, and masked results can contain
                    # inf/NaN. TM_CCOEFF_NORMED does not support a mask in
                    # OpenCV, so we match unmasked with the calibrated method.
                    result = cv2.matchTemplate(search_gray, resized, cv2.TM_CCOEFF_NORMED)
                    locs    = np.where(result >= thresh)
                    for pt in zip(*locs[::-1]):
                        candidates.append({
                            "score":       float(result[pt[1], pt[0]]),
                            "x":           pt[0] + rw // 2,
                            "y":           pt[1] + rh // 2,
                            "mw":          rw,
                            "mh":          rh,
                            "template_id": tmpl["template_id"],
                        })

        # Non-maximum suppression
        candidates.sort(key=lambda c: -c["score"])
        # Cap candidate list — with 8 templates × 4 rotations × 11 scales a low
        # threshold can yield hundreds of thousands of hits and the O(n²) NMS
        # below would hang the background task.
        candidates = candidates[:5000]
        kept = []
        code_hits = 0
        for c in candidates:
            if not any(
                abs(c["x"] - k["x"]) < k["mw"] * 0.5 and
                abs(c["y"] - k["y"]) < k["mh"] * 0.5
                for k in kept
            ):
                kept.append(c)
                fx = (c["x"] + x_offset) / full_img_w
                fy = c["y"] / full_img_h
                if LEGEND_X_CUTOFF <= fx <= 1.0 and 0.0 <= fy <= TITLE_Y_CUTOFF:
                    code_hits += 1
                    if code_hits > MAX_DETECTIONS_PER_CODE:
                        logger.warning(
                            "Detection cap hit for code %s (%d matches) — "
                            "template may be too generic; raise its threshold or delete it.",
                            code, code_hits,
                        )
                        break
                    detections.append({
                        "type":        code,
                        "imgX":        round(fx, 5),
                        "imgY":        round(fy, 5),
                        "confidence":  round(c["score"], 3),
                        "template_id": c["template_id"],
                        "verified":    False,
                        "method":      "template",
                    })

    return detections


# ── Combined PDF text parsing ─────────────────────────────────────────────────
def parse_pdf_page_text(pdf_path: str, page_num: int) -> tuple[list, list]:
    """
    Run pdftotext -bbox ONCE per page and return:
      (word_elements, page_dimensions)
    where page_dimensions = (page_w, page_h) or None if parsing failed.

    This avoids running two separate pdftotext subprocesses for symbol detection
    and door reference extraction.
    """
    try:
        result = subprocess.run(
            ["pdftotext", "-bbox", "-f", str(page_num), "-l", str(page_num),
             pdf_path, "-"],
            capture_output=True, text=True, errors="ignore", timeout=30
        )
    except Exception as e:
        logger.warning("pdftotext failed for page %d: %s", page_num, e)
        return [], None

    if not result.stdout.strip():
        return [], None

    try:
        xml = re.sub(r'<\?xml[^?]*\?>', '', result.stdout)
        root = ET.fromstring(xml)

        ns = "{http://www.w3.org/1999/xhtml}"
        page_el = root.find(f".//{ns}page")
        if page_el is None:
            page_el = root.find(".//page")
        if page_el is None:
            return [], None

        page_w = float(page_el.get("width",  1) or 1)
        page_h = float(page_el.get("height", 1) or 1)

        words = list(root.iter(f"{ns}word"))
        if not words:
            words = list(root.iter("word"))

        return words, (page_w, page_h)

    except ET.ParseError as e:
        logger.warning("pdftotext XML parse error on page %d: %s", page_num, e)
        return [], None
    except Exception as e:
        logger.warning("pdftotext parsing error on page %d: %s", page_num, e)
        return [], None


# ── Text-position detection ───────────────────────────────────────────────────
def find_text_positions_from_words(
    words: list,
    page_dims: tuple,
    symbol_codes: list = None,
) -> list[dict]:
    """
    Find symbol code positions from pre-parsed word elements.
    Uses single-word and multi-word matching.
    """
    if not words or page_dims is None:
        return []

    page_w, page_h = page_dims
    codes = symbol_codes if symbol_codes else DEFAULT_TEXT_CODES

    single_lookup: dict[str, str] = {}
    multi_lookup:  dict[tuple, str] = {}
    for code in codes:
        parts = code.strip().split()
        if len(parts) == 1:
            single_lookup[parts[0]] = code
        else:
            multi_lookup[tuple(parts)] = code

    detections = []

    def cx_cy(word_el):
        xmin = float(word_el.get("xmin", 0) or 0)
        ymin = float(word_el.get("ymin", 0) or 0)
        xmax = float(word_el.get("xmax", 0) or 0)
        ymax = float(word_el.get("ymax", 0) or 0)
        return (xmin + xmax) / 2 / page_w, (ymin + ymax) / 2 / page_h

    def in_area(cx, cy):
        return LEGEND_X_CUTOFF <= cx <= 1.0 and 0.0 <= cy <= TITLE_Y_CUTOFF

    def add(code, cx, cy, confidence=0.85):
        if in_area(cx, cy):
            detections.append({
                "type": code, "imgX": round(cx, 5), "imgY": round(cy, 5),
                "confidence": confidence, "verified": False, "method": "text",
            })

    # Single-word pass
    for w in words:
        t = (w.text or "").strip()
        if t in single_lookup:
            add(single_lookup[t], *cx_cy(w))

    # Multi-word pass
    if multi_lookup:
        max_span = max(len(k) for k in multi_lookup)
        for i in range(len(words)):
            for span in range(2, max_span + 1):
                if i + span > len(words):
                    break
                group = words[i:i + span]
                key = tuple((w.text or "").strip() for w in group)
                if key in multi_lookup:
                    xs = [float(w.get("xmin", 0) or 0) for w in group] + \
                         [float(w.get("xmax", 0) or 0) for w in group]
                    ys = [float(w.get("ymin", 0) or 0) for w in group] + \
                         [float(w.get("ymax", 0) or 0) for w in group]
                    cx = (min(xs) + max(xs)) / 2 / page_w
                    cy = (min(ys) + max(ys)) / 2 / page_h
                    add(multi_lookup[key], cx, cy)

    return detections


def find_text_positions(pdf_path: str, page_num: int,
                        symbol_codes: list = None) -> list[dict]:
    """
    Standalone text detection for a page (runs its own pdftotext call).
    Used when called outside the main pipeline.
    """
    words, page_dims = parse_pdf_page_text(pdf_path, page_num)
    detections = find_text_positions_from_words(words, page_dims, symbol_codes)

    # Plain-text fallback if bbox parsing yielded nothing
    if not detections:
        detections = _text_fallback(pdf_path, page_num, symbol_codes)

    return detections


def _text_fallback(pdf_path: str, page_num: int, symbol_codes: list = None) -> list[dict]:
    """
    Plain pdftotext fallback. Spreads detected occurrences in a grid rather
    than all at (0.5, 0.4), which would cause dedup to collapse them to one.
    """
    codes = symbol_codes if symbol_codes else DEFAULT_TEXT_CODES
    detections = []
    try:
        plain = subprocess.run(
            ["pdftotext", "-f", str(page_num), "-l", str(page_num), pdf_path, "-"],
            capture_output=True, text=True, errors="ignore", timeout=30
        ).stdout
        # Grid positions — spread so dedup doesn't collapse them
        grid_positions = [
            (0.3, 0.3), (0.5, 0.3), (0.7, 0.3),
            (0.3, 0.5), (0.5, 0.5), (0.7, 0.5),
            (0.3, 0.7), (0.5, 0.7), (0.7, 0.7),
        ]
        for code in codes:
            pat   = r'(?<![A-Za-z0-9])' + re.escape(code) + r'(?![A-Za-z0-9])'
            count = len(re.findall(pat, plain))
            for n in range(count):
                pos = grid_positions[n % len(grid_positions)]
                # Offset slightly so multiple codes don't overlap
                detections.append({
                    "type": code,
                    "imgX": round(pos[0] + (n // len(grid_positions)) * 0.05, 5),
                    "imgY": round(pos[1], 5),
                    "confidence": 0.4,
                    "verified": False,
                    "method": "text_fallback",
                })
    except Exception as e:
        logger.warning("text fallback failed for page %d: %s", page_num, e)
    return detections


# ── Door reference extraction ─────────────────────────────────────────────────
DOOR_PATTERN = re.compile(r'^D_[A-Z0-9]+(\.[A-Z0-9]+){1,3}$')


def find_door_references_from_words(words: list, page_dims: tuple) -> list[dict]:
    """Extract door references from pre-parsed word elements."""
    if not words or page_dims is None:
        return []

    page_w, page_h = page_dims
    refs = []

    for word in words:
        text = (word.text or "").strip()
        if DOOR_PATTERN.match(text):
            xmin = float(word.get("xmin", 0) or 0)
            ymin = float(word.get("ymin", 0) or 0)
            xmax = float(word.get("xmax", 0) or 0)
            ymax = float(word.get("ymax", 0) or 0)
            cx = (xmin + xmax) / 2 / page_w
            cy = (ymin + ymax) / 2 / page_h
            if LEGEND_X_CUTOFF <= cx <= 1.0 and 0.0 <= cy <= TITLE_Y_CUTOFF:
                refs.append({"ref": text, "imgX": round(cx, 5), "imgY": round(cy, 5)})

    return refs


def find_door_references(pdf_path: str, page_num: int) -> list[dict]:
    """Standalone door reference extraction (runs its own pdftotext call)."""
    words, page_dims = parse_pdf_page_text(pdf_path, page_num)
    return find_door_references_from_words(words, page_dims)


def nearest_door_ref(detection: dict, door_refs: list[dict],
                     max_distance: float = 0.05) -> Optional[str]:
    """Find the door reference closest to a detection point (within max_distance)."""
    best, best_dist = None, max_distance
    for ref in door_refs:
        dist = ((detection["imgX"] - ref["imgX"]) ** 2 +
                (detection["imgY"] - ref["imgY"]) ** 2) ** 0.5
        if dist < best_dist:
            best_dist = dist
            best = ref["ref"]
    return best


# ── Legend template extraction (fallback visual detection) ────────────────────
def extract_legend_templates(img: np.ndarray, active_codes: set) -> dict[str, np.ndarray]:
    """Extract CCTV symbol templates from the drawing's own legend."""
    if not any("CCTV" in c for c in active_codes):
        return {}

    h, w = img.shape[:2]
    leg  = img[int(h * 0.50):int(h * 0.90), 0:int(w * 0.25)]
    hsv  = cv2.cvtColor(leg, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([110, 40, 80]), np.array([130, 255, 255]))
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)

    comps = sorted(
        [s for s in stats[1:] if s[cv2.CC_STAT_AREA] > 100],
        key=lambda s: s[cv2.CC_STAT_TOP]
    )[:3]

    templates = {}
    pad   = 8
    names = ["CCTV_Dome", "CCTV_Fixed"]
    for i, stat in enumerate(comps[:2]):
        if names[i] not in active_codes:
            continue
        x  = max(0, stat[cv2.CC_STAT_LEFT] - pad)
        y  = max(0, stat[cv2.CC_STAT_TOP]  - pad)
        x2 = min(leg.shape[1], stat[cv2.CC_STAT_LEFT] + stat[cv2.CC_STAT_WIDTH]  + pad + 60)
        y2 = min(leg.shape[0], stat[cv2.CC_STAT_TOP]  + stat[cv2.CC_STAT_HEIGHT] + pad)
        crop = cv2.cvtColor(leg[y:y2, x:x2], cv2.COLOR_BGR2GRAY)
        if crop.size > 0:
            templates[names[i]] = crop

    return templates


# ── Deduplication ─────────────────────────────────────────────────────────────
def dedup(detections: list, min_dist: float = 0.008) -> list:
    # min_dist is normalised: 0.02 of a ~6600 px A1 page was ~130 px — it merged
    # genuinely distinct symbols mounted near each other. 0.008 (~50 px) keeps them.
    """
    Remove duplicates within min_dist.
    text_fallback detections are excluded from dedup (they're already spread).
    """
    fallbacks = [d for d in detections if d.get("method") == "text_fallback"]
    real      = [d for d in detections if d.get("method") != "text_fallback"]

    kept = []
    for d in real:
        if not any(
            d["type"] == k["type"] and
            abs(d["imgX"] - k["imgX"]) < min_dist and
            abs(d["imgY"] - k["imgY"]) < min_dist
            for k in kept
        ):
            kept.append(d)

    return kept + fallbacks


# ── Crop helper ───────────────────────────────────────────────────────────────
def crop_template_from_page(
    image_path: str,
    x1: float, y1: float, x2: float, y2: float,
    output_path: str,
    padding: float = 0.005,
) -> tuple[int, int]:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot read image: {image_path}")
    h, w = img.shape[:2]

    px, py = padding * w, padding * h
    ix1 = max(0, int(x1 * w - px))
    iy1 = max(0, int(y1 * h - py))
    ix2 = min(w, int(x2 * w + px))
    iy2 = min(h, int(y2 * h + py))

    if ix2 <= ix1 or iy2 <= iy1:
        raise ValueError("Invalid crop coordinates")

    crop = img[iy1:iy2, ix1:ix2]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, crop)
    return crop.shape[1], crop.shape[0]


# ── Main detection entry point ────────────────────────────────────────────────
def run_full_detection(
    pdf_path: str,
    pages_dir: str,
    symbol_codes: list = None,
    stored_templates: list = None,   # GlobalTemplate ORM objects
    drawing_firm: str = "",
    image_paths: list = None,        # pre-rendered page images; skips rendering
) -> dict:
    """
    Full pipeline per page:
    1. Template matching (stored GlobalTemplates, firm-prioritised, with rotation+scale)
    2. Text-position detection for labelled symbols
    3. Legend template fallback for visual CCTV symbols with no stored templates
    4. Deduplication
    5. Door reference enrichment

    pdftotext is called ONCE per page and shared between steps 2 and 5.
    """
    if image_paths is None:
        image_paths = render_pdf_pages(pdf_path, pages_dir)
    active_codes = set(symbol_codes) if symbol_codes else set()

    # Load stored templates (firm-aware ranking)
    db_templates_by_code: dict[str, list] = {}
    if stored_templates:
        db_templates_by_code = load_templates(stored_templates, drawing_firm=drawing_firm)

    has_templates = set(db_templates_by_code.keys())
    needs_text    = active_codes - has_templates if active_codes else set()
    needs_legend  = {c for c in active_codes if "CCTV" in c and c not in has_templates}

    page_results = []
    summary: dict[str, int] = {}

    for i, img_path in enumerate(image_paths, start=1):
        page_dets = []

        # Parse PDF text ONCE for this page (used for both symbol text and door refs)
        words, page_dims = parse_pdf_page_text(pdf_path, i)

        # --- Template matching ---
        img = None
        if db_templates_by_code:
            img = cv2.imread(img_path)
            if img is not None:
                h, w   = img.shape[:2]
                x_off  = int(w * LEGEND_X_CUTOFF)
                search = img[0:int(h * TITLE_Y_CUTOFF), x_off:]
                sh, sw = search.shape[:2]
                sg     = cv2.cvtColor(search, cv2.COLOR_BGR2GRAY)
                page_dets += match_templates_on_page(
                    sg, sh, sw, x_off, w, h, db_templates_by_code
                )

        # --- Text detection ---
        # Codes with NO templates always use text detection. Additionally, any
        # code whose templates found ZERO matches on THIS page falls back to
        # text detection — having a template must never mean "no detections at
        # all" when the template simply didn't match.
        tmpl_found_codes = {d["type"] for d in page_dets}
        page_text_codes  = set(needs_text) | {
            c for c in (active_codes & has_templates) if c not in tmpl_found_codes
        }
        text_codes = list(page_text_codes) if page_text_codes else \
                     (list(active_codes) if active_codes and not has_templates else None)
        if text_codes:
            text_dets = find_text_positions_from_words(words, page_dims, text_codes)
            if not text_dets:
                text_dets = _text_fallback(pdf_path, i, text_codes)
            page_dets += text_dets

        # --- Legend fallback for CCTV codes with no detections so far ---
        page_needs_legend = needs_legend | {
            c for c in active_codes
            if "CCTV" in c and c not in {d["type"] for d in page_dets}
        }
        if page_needs_legend:
            if img is None:
                img = cv2.imread(img_path)
            if img is not None:
                legend_tmpls = extract_legend_templates(img, page_needs_legend)
                if legend_tmpls:
                    h, w   = img.shape[:2]
                    x_off  = int(w * LEGEND_X_CUTOFF)
                    search = img[0:int(h * TITLE_Y_CUTOFF), x_off:]
                    sh, sw = search.shape[:2]
                    sg     = cv2.cvtColor(search, cv2.COLOR_BGR2GRAY)
                    legend_by_code = {
                        k: [{"image": v, "threshold": 0.65,
                             "template_id": None, "quality_score": 0.5,
                             "firm_match": False}]
                        for k, v in legend_tmpls.items()
                    }
                    # Legend fallback uses lower threshold (0.65) and no rotations
                    page_dets += match_templates_on_page(
                        sg, sh, sw, x_off, w, h, legend_by_code, use_rotations=False
                    )

        page_dets = dedup(page_dets)

        # Enrich with nearest door reference (reuse already-parsed words)
        door_refs = find_door_references_from_words(words, page_dims)
        for det in page_dets:
            dr = nearest_door_ref(det, door_refs)
            if dr:
                det["door_ref"] = dr

        for d in page_dets:
            t = d["type"]
            summary[t] = summary.get(t, 0) + 1

        page_results.append({
            "page":       i,
            "image_path": img_path,
            "detections": page_dets,
            "door_refs":  door_refs,
        })

    return {
        "total_pages":  len(image_paths),
        "page_results": page_results,
        "summary":      summary,
    }
