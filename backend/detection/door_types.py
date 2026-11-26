"""
A door types sheet: the architect's page of door elevations, each headed with
its type, whether it is an internal or external door, and the doors it covers.

    Type_8 - External door
    Location - D018, D019, D020, D021, D022

From it every door on the job learns its type and its side (internal or
external), and the fire rating printed in its type's panel. A door listed here
that is not found on the plans is said, so it is never lost.
"""
import re

_TYPE = re.compile(r"^\s*(?:door\s+)?type[\s_\-]*([A-Za-z0-9]{1,6})\s*[-–:]\s*(internal|external)(?:\s+door)?\b", re.I)
_LOC = re.compile(r"^\s*(?:location|locations|door(?:s)?|refs?)\s*[-–:]\s*(.+)$", re.I)
_FIRE = re.compile(r"\b(EI\s?\d{2,3}|FD\s?\d{2,3}S?|E\s?\d{2,3}|EN\s?\d{2,3}S?)\b[^\n]{0,20}?FIRE\s+RATED|\bNON[\s-]*FIRE[\s-]*RATED\b", re.I)


def _lines(page) -> list[tuple]:
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            t = "".join(s["text"] for s in l["spans"]).strip()
            if t:
                out.append((t, l["bbox"]))
    return out


def _refs(text: str) -> list[str]:
    """'D007, D011 & D014', 'D-01, D-02' -> refs, written as on the plans. A letter O typed
    for a nought (DOO8, DO17) is read as one."""
    out = []
    for m in re.finditer(r"\b([A-Z]{1,3}?)([-./]?)([0-9O]*\d[0-9O]*)([A-Z]?)\b", text.upper()):
        out.append(m.group(1) + m.group(2) + m.group(3).replace("O", "0") + m.group(4))
    return out


def read_types(page) -> dict:
    """{ref: {"type": "Type 8", "side": "external", "fire": "EI30"}} and where each list sits, or {} when
    the page is not a door types sheet."""
    lines = _lines(page)
    heads = []
    for i, (t, bb) in enumerate(lines):
        m = _TYPE.match(t)
        if m:
            heads.append((m.group(1), m.group(2).lower(), bb))
    if len(heads) < 2:
        return {}
    fires = [(t, bb) for t, bb in lines if _FIRE.search(t)]
    types, where = {}, {}
    for name, side, hb in heads:
        # the location line: just under the type line, starting at about the same place
        loc = None
        for t, bb in lines:
            if 0 <= bb[1] - hb[1] <= 3 * (hb[3] - hb[1]) + 2 and abs(bb[0] - hb[0]) <= 12 and _LOC.match(t):
                loc = (t, bb)
                break
        if not loc:
            continue
        refs = _refs(_LOC.match(loc[0]).group(1))
        if not refs:
            continue
        # the fire rating in this type's panel: the nearest one below it, in its column
        fire = ""
        below = [(t, bb) for t, bb in fires if 0 < bb[1] - hb[1] < 600 and hb[0] - 120 <= bb[0] <= hb[0] + 260]
        if below:
            t, _ = min(below, key=lambda f: (f[1][1] - hb[1]) + abs(f[1][0] - hb[0]))
            m = re.search(r"(EI\s?\d{2,3}|FD\s?\d{2,3}S?|EN\s?\d{2,3}S?|E\s?\d{2,3})", t, re.I)
            fire = re.sub(r"\s", "", m.group(1)).upper() if m else "Not fire rated"
        label = f"Type {name}"
        for r in refs:
            types[r] = {"type": label, "side": side, "fire": fire}
            where[r] = loc[1]
    if len(types) < 3:
        return {}
    return {"types": types, "where": where}
