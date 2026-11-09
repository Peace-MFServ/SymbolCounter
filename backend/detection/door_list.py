"""
A door list from an architect's spreadsheet (.xlsx, .xlsm, .csv): whatever the
layout, find the column of door numbers, the floor each door is on, and what
else the row says about it (room, fire rating, type), for a person to look over.

No template is assumed. The door column is found by its heading ("Door No.",
"Door Ref", "Tag", "Mark" ...) or, failing that, as the column whose cells look
most like door numbers: short, with a number in them, nearly all different.
Floors come from a floor column, or from heading rows between the doors
("GROUND FLOOR", "Level 2"). A second table further down (windows, rooflights)
ends the doors.
"""
import csv
import io
import re
from collections import Counter

MAX_ROWS = 6000
MAX_COLS = 80

_FLOOR_WORDS = r"BASEMENT|LOWER GROUND|UPPER GROUND|GROUND|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ROOF|MEZZANINE|ATTIC"
_FLOOR_HEAD = re.compile(rf"^\s*(?:({_FLOOR_WORDS})\s*(?:FLOOR|LEVEL)?|(?:LEVEL|FLOOR|STOREY)\s*(-?\d{{1,2}})|(B|LG|UG|G|GF|FF|SF|TF|L-?\d{{1,2}}))\s*(?:PLAN|DOORS)?\s*:?\s*$", re.I)

_HEADS = {
    "door": re.compile(r"^(door|dr\.?|leaf)?\s*(no\.?|nr\.?|number|num\.?|ref\.?|reference|tag|mark|id|code|#)$|^door$", re.I),
    "floor": re.compile(r"^(floor|level|storey|story|lvl\.?)(\s*(no\.?|name|ref\.?))?$", re.I),
    "room": re.compile(r"^(room|location|space|area)(\s*(no\.?|nr\.?|number|name|ref\.?|reference|description))?$|^(from|to)\s*(room)?$", re.I),
    "fire": re.compile(r"^(fire|fire\s*rating|fire\s*resistance|fr|fd\s*rating|fire\s*door)(\s*\(.*\))?$", re.I),
    "type": re.compile(r"^(door\s*)?(type|style)(\s*(no\.?|ref\.?|code))?$", re.I),
    "description": re.compile(r"^(description|desc\.?|door\s*description|comments?|notes?|remarks?)$", re.I),
}
_OTHER_TABLE = re.compile(r"^(window|rooflight|roof\s*light|screen|glazing|louvre|hatch)s?\s*(no\.?|nr\.?|number|ref\.?|reference|tag|mark|id)?$", re.I)


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return " ".join(str(v).split())


def _sheets(name: str, data: bytes) -> list[tuple[str, list[list[str]]]]:
    low = (name or "").lower()
    if low.endswith(".csv"):
        text = data.decode("utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4000], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = [[_cell(c) for c in r[:MAX_COLS]] for r in csv.reader(io.StringIO(text), dialect)][:MAX_ROWS]
        return [(name, rows)]
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    out = []
    for ws in wb.worksheets:
        if getattr(ws, "sheet_state", "visible") != "visible":
            continue
        rows = []
        for r in ws.iter_rows(values_only=True, max_col=MAX_COLS):
            rows.append([_cell(c) for c in r])
            if len(rows) >= MAX_ROWS:
                break
        out.append((ws.title, rows))
    return out


def _looks_like_ref(v: str, numbers: bool = False) -> bool:
    """Short, with a number in it, not a measurement. Bare numbers (101) count only
    where the column is headed as door numbers; elsewhere 900 is a width."""
    if not v or len(v) > 24 or not re.search(r"\d", v) or len(v.split()) > 2:
        return False
    if numbers and re.fullmatch(r"\d{1,6}", v):
        return True
    return not re.fullmatch(r"[\d.,\s/%x×-]+(mm|m)?", v, re.I)          # 900, 2100 x 926, 30/30, 12.5


def _shape(v: str) -> str:
    return re.sub(r"\d+", "#", v.upper())


def _find_table(rows: list[list[str]]):
    """(header row index or None, {field: column}) for the door table on a sheet."""
    # by heading: the first row in the top of the sheet with a door number heading
    for i, row in enumerate(rows[:60]):
        cols = {}
        for j, c in enumerate(row):
            for field, rx in _HEADS.items():
                if field not in cols and c and rx.match(c.strip()):
                    cols[field] = j
                    break
        if "door" in cols:
            # headings split over two rows ("Fire rating" over "30 min"): look one row down too
            if i + 1 < len(rows):
                for j, c in enumerate(rows[i + 1]):
                    for field, rx in _HEADS.items():
                        if field not in cols and field != "door" and c and rx.match(c.strip()):
                            cols[field] = j
            return i, cols
    # by content: the column that reads most like door numbers
    best = None
    width = max((len(r) for r in rows), default=0)
    for j in range(min(width, MAX_COLS)):
        vals = [r[j] for r in rows if j < len(r) and _looks_like_ref(r[j])]
        if len(vals) < 3:
            continue
        shapes = Counter(_shape(v) for v in vals)
        top = shapes.most_common(1)[0][1]
        uniq = len(set(v.upper() for v in vals)) / len(vals)
        score = len(vals) * uniq * (top / len(vals)) * (1.3 if re.match(r"[A-Z]", shapes.most_common(1)[0][0]) else 1.0)
        if best is None or score > best[0]:
            best = (score, j)
    if best and best[0] >= 3:
        return None, {"door": best[1]}
    return None, {}


def _floor_from(text: str) -> str:
    m = _FLOOR_HEAD.match(text or "")
    if not m:
        return ""
    if m.group(1):
        w = m.group(1).title()
        return w if w in ("Basement", "Roof", "Mezzanine", "Attic") else f"{w} Floor"
    if m.group(2):
        return f"Level {int(m.group(2))}"
    short = m.group(3).upper()
    return {"B": "Basement", "LG": "Lower Ground Floor", "UG": "Upper Ground Floor", "G": "Ground Floor",
            "GF": "Ground Floor", "FF": "First Floor", "SF": "Second Floor", "TF": "Third Floor"}.get(
        short, f"Level {re.sub(r'[^0-9-]', '', short)}" if re.search(r"\d", short) else short)


def read_door_list(name: str, data: bytes) -> dict:
    try:
        sheets = _sheets(name, data)
    except Exception:
        return {"problem": "That file could not be opened. Save it as .xlsx or .csv and try again.", "doors": [], "sheets": []}

    found = []
    for title, rows in sheets:
        hi, cols = _find_table(rows)
        if "door" in cols:
            n = sum(1 for r in rows[(hi if hi is not None else -1) + 1:] if cols["door"] < len(r) and _looks_like_ref(r[cols["door"]], hi is not None))
            found.append((n, title, rows, hi, cols))
    if not found:
        return {"problem": "No column of door numbers was found in this file. It needs a column headed Door No. (or Door Ref, Tag, Mark), "
                           "or a column of door numbers such as D-01, D-02.", "doors": [], "sheets": [t for t, _ in sheets]}
    found.sort(key=lambda f: -f[0])
    _, title, rows, hi, cols = found[0]
    dc = cols["door"]
    header = rows[hi] if hi is not None else []
    col_names = {k: (header[j] if j < len(header) and header[j] else f"column {_col_letter(j)}") for k, j in cols.items()}

    doors, floor, seen = [], "", {}
    start = (hi + 1) if hi is not None else 0
    by_head = hi is not None
    shapes = Counter(_shape(r[dc]) for r in rows[start:] if dc < len(r) and _looks_like_ref(r[dc], by_head))
    fire_cols = _ticked_group(rows, hi, cols, "fire")
    if fire_cols:
        col_names["fire"] = ", ".join(h for _, h in fire_cols)
    lead = Counter(re.match(r"[A-Za-z]*[-./_ ]?", s).group(0) for s in shapes.elements()).most_common(1)
    lead = lead[0][0] if lead else ""
    for i in range(start, len(rows)):
        row = rows[i]
        filled = [c for c in row if c]
        if not filled:
            continue
        v = row[dc] if dc < len(row) else ""
        # a floor heading row: "GROUND FLOOR" alone on its row (in any column)
        if len(filled) <= 2 and _floor_from(filled[0]) and not _looks_like_ref(v, by_head):
            floor = _floor_from(filled[0]); continue
        # the start of another table (windows, rooflights) ends the doors
        if any(_OTHER_TABLE.match(c) for c in filled[:3]):
            break
        if not v or (hi is not None and v.lower() == header[dc].lower()):
            continue
        get = lambda k: (row[cols[k]] if k in cols and cols[k] < len(row) else "")
        fire = get("fire")
        if fire_cols:
            fire = " / ".join(header_of if row[j].upper() in _TICKS else row[j]
                              for j, header_of in fire_cols if j < len(row) and row[j])
        fl = get("floor")
        door = {"id": f"r{i + 1}", "row": i + 1, "ref": v, "floor": (_floor_from(fl) or fl) if fl else floor, "room": get("room"),
                "fire": fire, "type": get("type"), "description": get("description"),
                "status": "green", "reasons": []}
        if not _looks_like_ref(v, by_head):
            # no number in it: a lift door "D-E-LIFT" is kept for a look, a heading or a note is not
            if len(v) <= 24 and lead and v.upper().startswith(lead.upper()) and len(v.split()) <= 2:
                door["status"], door["reasons"] = "amber", ["No number in it, unlike the other door numbers"]
            else:
                continue
        elif shapes[_shape(v)] == 1 and len(shapes) > 1 and lead and not v.upper().startswith(lead.upper()):
            door["status"], door["reasons"] = "amber", ["Does not look like the other door numbers"]
        key = v.upper().replace(" ", "")
        if key in seen:
            door["status"] = "amber"
            door["reasons"].append(f"Listed twice: also on row {seen[key]}")
        else:
            seen[key] = i + 1
        doors.append(door)
    return {"sheet": title, "sheets": [t for t, _ in sheets], "columns": col_names, "doors": doors,
            "totals": {"green": sum(1 for d in doors if d["status"] == "green"),
                       "amber": sum(1 for d in doors if d["status"] == "amber")}}


_TICKS = {"X", "Y", "YES", "✓", "✔", "TRUE", "1", "•", "●"}


def _ticked_group(rows, hi, cols, field):
    """Columns ticked with an X under a group heading on the row above the headings:
    "FIRE RATING" over "30 Minutes" | "60 Minutes". [(column, its heading)]."""
    if hi is None or hi == 0 or field in cols:
        return []
    above, head = rows[hi - 1], rows[hi]
    rx = _HEADS[field]
    for j, c in enumerate(above):
        if c and rx.match(c.strip()):
            out = [(j, head[j] if j < len(head) else "")]
            k = j + 1
            while k < len(above) and k < len(head) and not above[k] and head[k]:
                out.append((k, head[k])); k += 1
            return [(c_, h) for c_, h in out if h]
    return []


def _col_letter(j: int) -> str:
    s = ""
    j += 1
    while j:
        j, r = divmod(j - 1, 26)
        s = chr(65 + r) + s
    return s
