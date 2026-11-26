"""The floor a plan shows, from its file name."""
import re

FLOOR_WORDS = {
    "basement": "Basement", "lower ground": "Lower Ground", "ground": "Ground", "first": "First",
    "second": "Second", "third": "Third", "fourth": "Fourth", "fifth": "Fifth", "sixth": "Sixth",
    "seventh": "Seventh", "eighth": "Eighth", "ninth": "Ninth", "tenth": "Tenth", "roof": "Roof",
    "mezzanine": "Mezzanine", "penthouse": "Penthouse",
}


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
