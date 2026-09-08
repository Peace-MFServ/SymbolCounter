"""
Door extraction from architects' plans.

Every door on a GA plan carries a small text tag next to it: the door type
("DT-01", "DT-01h" for the handed version) or a unique door reference
("D01-001", "D_BA01.00.20"). Reading those tags off the PDF text layer gives
the door list for a job in seconds, and the floor comes from the drawing.
"""
import re

try:
    import pymupdf as fitz
except ImportError:  # older installs expose the module as fitz
    import fitz

# Tag patterns. Each yields (code, ref, handed): a repeated code such as
# "D-01" / "ED-01" / "DT-01" is a door type; a unique one such as "D101" or
# "D01-001" is a single door's reference.
# Prefixes architects use for door tags: D, DT (door type), ED (external), ID (internal), FD (fire), SD (sliding), DD (double)
_TYPE_TAG = re.compile(r"^((?:D|DT|ED|ID|FD|SD|DD)[-\s]?\d{1,3}(?:[-.]\d{1,2})?)([hH])?$")   # D-01, ED-01, DT-05-02, DT-01h, D101
_REF_DASH = re.compile(r"^(D\d{2})-(\d{3})$")                                       # D01-001  (type D01, ref D01-001)
_REF_DOT  = re.compile(r"^D_[A-Z0-9]+(?:\.[A-Z0-9]+){1,3}$", re.I)                  # D_BA01.00.20
_REF_MISC = re.compile(r"^(?:DR|DOOR)[-\s]?(\d{1,4})([A-Za-z])?$")                   # DR-12, DOOR 7
_NOT_TAGS = {"D", "DT", "ED"}

FLOOR_WORDS = {
    "basement": "Basement", "lower ground": "Lower Ground", "ground": "Ground", "first": "First",
    "second": "Second", "third": "Third", "fourth": "Fourth", "fifth": "Fifth", "sixth": "Sixth",
    "seventh": "Seventh", "eighth": "Eighth", "ninth": "Ninth", "tenth": "Tenth", "roof": "Roof",
    "mezzanine": "Mezzanine", "penthouse": "Penthouse",
}
FLOOR_SHORT = {"Basement": "B", "Lower Ground": "LG", "Ground": "G", "First": "1", "Second": "2",
               "Third": "3", "Fourth": "4", "Fifth": "5", "Sixth": "6", "Seventh": "7", "Eighth": "8",
               "Ninth": "9", "Tenth": "10", "Roof": "R", "Mezzanine": "M", "Penthouse": "PH"}
# Floor labels architects print under a door tag: "GFL" = ground floor level
FLOOR_HINTS = {"BFL": "Basement", "LGF": "Lower Ground", "LGFL": "Lower Ground", "GF": "Ground", "GFL": "Ground",
               "FF": "First", "FFL": "First", "SF": "Second", "SFL": "Second", "TF": "Third", "TFL": "Third",
               "00": "Ground", "01": "First", "02": "Second", "03": "Third", "04": "Fourth", "05": "Fifth"}


def floor_from_name(name: str) -> str:
    """'PLE-AA-L02-DR-JFA-AR-W2002-First-Floor-GA-Plan-Rev.E.pdf' -> 'First'; also 'GroundFloorPlan'."""
    n = (name or "").replace("_", " ").replace("-", " ").lower()
    for word, label in FLOOR_WORDS.items():
        if re.search(rf"\b{word}\b", n):
            return label
    for word, label in FLOOR_WORDS.items():          # run-together names: "GroundFloorPlan"
        if re.search(rf"{word}(?=floor|level|plan)", n):
            return label
    m = re.search(r"\b(?:level|lvl|lev)\s*(\d{1,2})\b", n)
    if m:
        return f"Level {int(m.group(1))}"
    m = re.search(r"\bl(\d{2})\b", n)
    if m:
        return f"Level {int(m.group(1))}"
    return ""


def floor_short(floor: str) -> str:
    if floor in FLOOR_SHORT:
        return FLOOR_SHORT[floor]
    m = re.match(r"Level (\d+)", floor or "")
    return f"L{m.group(1)}" if m else (floor[:3].upper() if floor else "X")


def norm_code(code: str) -> str:
    """'D01' -> 'D-01', 'ED-1' -> 'ED-01', 'DT 5' -> 'DT-05', 'DT-05-02' stays."""
    m = re.fullmatch(r"([A-Z]{1,3})[-\s]?(\d{1,3})(?:[-.](\d{1,2}))?", code.upper().strip())
    if not m:
        return code.upper()
    num = m.group(2)
    num = num.zfill(2) if len(num) < 3 else num
    return f"{m.group(1)}-{num}" + (f"-{int(m.group(3)):02d}" if m.group(3) else "")


def parse_tag(text: str):
    """
    Return (code, ref, handed) for a door tag word, or None. 'code' is the
    normalised tag ("D-01", "ED-01", "DT-05"); whether that is a type shared
    by many doors or one door's own reference is decided per drawing by
    extract_door_tags / the caller, since only repetition tells them apart.
    """
    t = (text or "").strip()
    if not t or t.upper() in _NOT_TAGS:
        return None
    m = _REF_DASH.match(t.upper())
    if m:
        return m.group(1), t.upper(), False
    if _REF_DOT.match(t):
        return "", t.upper(), False
    m = _TYPE_TAG.match(t.upper()) if t[:1].isalpha() else None
    if m:
        return norm_code(m.group(1)), "", bool(m.group(2))
    m = _REF_MISC.match(t)
    if m:
        return "", t.upper(), False
    # A stray character glued to the front ("tD-01"): take the tag off the end,
    # but not from abbreviations like "Ht.D1" (no hyphen, or a dot before it).
    m = re.search(r"(?<![A-Z.])((?:D|DT|ED|ID|FD|SD|DD)-\d{1,3})([hH])?$", t.upper()[1:] if t[:1].islower() else "")
    if m and len(t) <= len(m.group(0)) + 2:
        return norm_code(m.group(1)), "", bool(m.group(2))
    return None


def _legend_boxes(page) -> list:
    """Rectangles drawn around a KEY / LEGEND title; tags inside them are examples, not doors."""
    titles = [w for w in page.get_text("words") if re.fullmatch(r"(KEY|LEGEND)[:.]?", w[4].strip())]
    if not titles:
        return []
    page_area = page.rect.width * page.rect.height
    boxes = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    for t in titles:
        tr = fitz.Rect(t[:4])
        best = None
        for d in drawings:
            r = d.get("rect")
            if r is None or r.is_empty:
                continue
            area = r.width * r.height
            if area > page_area * 0.15 or area < tr.width * tr.height * 4:
                continue
            if r.contains(tr) and (best is None or area < best.width * best.height):
                best = r
        if best is not None:
            boxes.append(best)
    return boxes


def extract_door_tags(pdf_path: str, page_num: int) -> list[dict]:
    """
    Door tags on one page: [{code, ref, handed, x, y, floor_hint}] with x, y
    normalised to the page. Tags inside a KEY / LEGEND box are dropped.
    'code' is the tag as printed (normalised); the caller decides type vs ref.
    """
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_num - 1]
        W, H = page.rect.width, page.rect.height
        words = page.get_text("words")
        legend = _legend_boxes(page)
        out = []
        for w in words:
            parsed = parse_tag(w[4])
            if not parsed:
                continue
            r = fitz.Rect(w[:4])
            if any(b.contains(r) for b in legend):
                continue
            # A legend entry has its meaning printed beside it: "ED-2  Door No."
            beside = " ".join(v[4] for v in words
                              if v is not w and 0 <= v[0] - r.x1 < r.width * 4 and abs(((v[1] + v[3]) / 2) - ((r.y0 + r.y1) / 2)) < r.height)
            if re.search(r"\bdoor", beside, re.I):
                continue
            code, ref, handed = parsed
            # A floor label printed just under the tag ("GFL"), often overlapping it
            hint = ""
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            for v in words:
                if v is w:
                    continue
                vcx, vcy = (v[0] + v[2]) / 2, (v[1] + v[3]) / 2
                if abs(vcx - cx) < r.width and 0.4 * r.height < vcy - cy < 1.6 * r.height:
                    hint = FLOOR_HINTS.get(v[4].strip().upper(), "")
                    if hint:
                        break
            out.append({"code": code, "ref": ref, "handed": handed, "floor_hint": hint,
                        "x": round(((w[0] + w[2]) / 2) / W, 4), "y": round(((w[1] + w[3]) / 2) / H, 4)})
        return out
    finally:
        doc.close()


def split_types_and_refs(tags: list[dict], known_types: set) -> None:
    """
    Decide, for tags that carry a code but no ref, whether the code is a
    door type or the door's own number. A code seen more than once on the
    drawing, or already a type on the project, is a type; a code with a
    number of 100 or more ("D101") is a single door. Sets type_code / ref
    on each tag in place.
    """
    from collections import Counter
    seen = Counter(t["code"] for t in tags if t["code"] and not t["ref"])
    # A prefix family ("D-", "ED-") is type-like when any of its codes repeats
    type_prefixes = {"DT"} | {c.split("-")[0] for c, n in seen.items() if n > 1}
    for t in tags:
        code, ref = t["code"], t["ref"]
        if ref:                                   # D01-001 style: type + ref already known
            t["type_code"] = code
            continue
        m = re.match(r"^([A-Z]+)-(\d+)", code)
        prefix = m.group(1) if m else code
        big = bool(m) and int(m.group(2)) >= 100 and prefix != "DT"
        if not big and (code in known_types or prefix in type_prefixes):
            t["type_code"], t["ref"] = code, ""
        else:
            t["type_code"], t["ref"] = "", code.replace("-", "") if big else code


def looks_like_door_plan(tags: list[dict]) -> bool:
    """A page with a couple of stray matches is not a door plan; a page with many is."""
    return len(tags) >= 3
