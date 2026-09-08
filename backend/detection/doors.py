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

# Tag patterns, most specific first. Each yields (type_code, ref, handed).
_TYPE_TAG = re.compile(r"^(DT[-\s]?\d{1,3}(?:[-.]\d{1,2})?)([hH])?$")          # DT-01, DT-05-02, DT-01h
_REF_DASH = re.compile(r"^(D\d{2})-(\d{3})$")                                    # D01-001  (type D01, ref D01-001)
_REF_DOT  = re.compile(r"^D_[A-Z0-9]+(?:\.[A-Z0-9]+){1,3}$", re.I)               # D_BA01.00.20
_REF_MISC = re.compile(r"^(?:D|DR|DOOR)[-\s]?(\d{1,4})([A-Za-z])?$")             # D101, DR-12, D101A

FLOOR_WORDS = {
    "basement": "Basement", "lower ground": "Lower Ground", "ground": "Ground", "first": "First",
    "second": "Second", "third": "Third", "fourth": "Fourth", "fifth": "Fifth", "sixth": "Sixth",
    "seventh": "Seventh", "eighth": "Eighth", "ninth": "Ninth", "tenth": "Tenth", "roof": "Roof",
    "mezzanine": "Mezzanine", "penthouse": "Penthouse",
}
FLOOR_SHORT = {"Basement": "B", "Lower Ground": "LG", "Ground": "G", "First": "1", "Second": "2",
               "Third": "3", "Fourth": "4", "Fifth": "5", "Sixth": "6", "Seventh": "7", "Eighth": "8",
               "Ninth": "9", "Tenth": "10", "Roof": "R", "Mezzanine": "M", "Penthouse": "PH"}


def floor_from_name(name: str) -> str:
    """'PLE-AA-L02-DR-JFA-AR-W2002-First-Floor-GA-Plan-Rev.E.pdf' -> 'First'."""
    n = (name or "").replace("_", " ").replace("-", " ").lower()
    for word, label in FLOOR_WORDS.items():
        if re.search(rf"\b{word}\b", n):
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


def parse_tag(text: str):
    """Return (type_code, ref, handed) for a door tag word, or None."""
    t = (text or "").strip()
    m = _TYPE_TAG.match(t)
    if m:
        code = m.group(1).upper().replace(" ", "-")
        if "-" not in code:
            code = code[:2] + "-" + code[2:]
        return code, "", bool(m.group(2))
    m = _REF_DASH.match(t.upper())
    if m:
        return m.group(1), t.upper(), False
    if _REF_DOT.match(t):
        return "", t.upper(), False
    m = _REF_MISC.match(t)
    if m and len(t) >= 3:
        return "", t.upper(), False
    return None


def extract_door_tags(pdf_path: str, page_num: int) -> list[dict]:
    """
    Door tags on one page: [{type_code, ref, handed, x, y}] with x, y
    normalised to the page. Tags inside the drawing's own legend or title
    block are still returned; the caller decides what to keep.
    """
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_num - 1]
        W, H = page.rect.width, page.rect.height
        out = []
        for w in page.get_text("words"):
            parsed = parse_tag(w[4])
            if not parsed:
                continue
            code, ref, handed = parsed
            out.append({"type_code": code, "ref": ref, "handed": handed,
                        "x": round(((w[0] + w[2]) / 2) / W, 4), "y": round(((w[1] + w[3]) / 2) / H, 4)})
        return out
    finally:
        doc.close()


def looks_like_door_plan(tags: list[dict]) -> bool:
    """A page with a couple of stray matches is not a door plan; a page with many is."""
    return len(tags) >= 3
