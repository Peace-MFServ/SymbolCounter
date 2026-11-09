"""
Reading door tags off any architect's floor plan, with no list of tag styles.

Architects label doors their own way: AD043, D1-645/3, DG.27, 1234, R-12,
XX44. Nothing here knows any of those. Each plan is read on its own terms:

1. Every short label on the sheet is collected: printed text, rotated text
   and mark-up boxes added to the PDF afterwards.
2. Labels are grouped into families by their shape. The letters are kept as
   they are and each run of digits stands for "a number", so DG.27 and DG.05
   are one family and WG.12 (windows) another.
3. Each family is scored on what makes door tags door tags on any drawing:
   they sit at doors (a swing arc, or a highlighted door line), there are many
   of them, each appears once, and their numbers run in sequence. A drawing key
   that names the family as doors counts strongly too.
4. The best family is chosen, and a person can change or add families by
   pointing at one label.
5. The result is checked against itself: gaps in the numbering, near misses
   (DI-659/3 for D1-659/3), tags printed twice, a tag far from any door, and
   doors drawn with no tag. Everything that passes is green, everything a check
   doubts is amber for a person to look at.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

try:
    import pymupdf as fitz
except ImportError:          # older installs
    import fitz

from detection.doors import floor_from_name

MAX_LABEL = 18               # longer words are sentences, not tags
NEAR_DOOR = 1.6              # a tag counts as at a door within this many door widths
GEO_RELIABLE = 0.6           # tags sit at drawn doors this often: bare doors are worth flagging
STRAY_RELIABLE = 0.85        # and this often on the sheet before a tag away from doors is doubted


# ── Labels ────────────────────────────────────────────────────────────────────
def _clean(t: str) -> str:
    t = (t or "").strip().strip(",;:()[]{}").strip()
    # a dash left hanging on the end ("D28- 2200mm x 980mm") is not part of the tag
    return re.sub(r"(?<=\d)[-\u2013\u2014]+$", "", t)


def _labels(page, page_no: int, file_no: int) -> list[dict]:
    """Every short word with a digit in it, from the text and from mark-up boxes."""
    out = []
    words = page.get_text("words")
    # a tag split by the PDF into two words ("AD" "043") is joined back up
    words = sorted(words, key=lambda w: (round(w[1], 1), w[0]))
    used = set()
    for i, w in enumerate(words):
        if i in used:
            continue
        text, rect = _clean(w[4]), fitz.Rect(w[:4])
        if re.fullmatch(r"[A-Za-z]{1,4}[-./]?", text) and i + 1 < len(words):
            n = words[i + 1]
            gap = n[0] - w[2]
            if abs(n[1] - w[1]) < (w[3] - w[1]) * 0.3 and 0 <= gap < (w[3] - w[1]) * 0.35 and re.match(r"\d", _clean(n[4])):
                text, rect = text + _clean(n[4]), rect | fitz.Rect(n[:4]); used.add(i + 1)
        # a list of doors in one callout: "BD1,2 & 3", "D4, 5 and 6"
        m = re.fullmatch(r"([A-Za-z]{1,4}[-./]?)(\d{1,4})((?:,\d{1,4})*),?", text)
        if m:
            nums = [m.group(2)] + [x for x in m.group(3).split(",") if x]
            j = i + 1
            while j + 1 < len(words) and abs(words[j][1] - w[1]) < (w[3] - w[1]) * 0.5 and words[j][0] - rect.x1 < (w[3] - w[1]) * 2 \
                    and _clean(words[j][4]).lower() in ("&", "and", ",") and re.fullmatch(r"\d{1,4}", _clean(words[j + 1][4])):
                nums.append(_clean(words[j + 1][4])); rect = rect | fitz.Rect(words[j + 1][:4]); used |= {j, j + 1}; j += 2
            if len(nums) > 1:
                for n_ in nums:
                    out.append({"text": f"{m.group(1)}{n_}", "rect": fitz.Rect(rect), "src": "text"})
                continue
        if 1 <= len(text) <= MAX_LABEL * 2 + 1 and re.search(r"\d", text):
            parts = _split_joined(text, rect)
            for part, pr in parts:
                if len(part) <= MAX_LABEL:
                    # the box of two touching tags is taller than one tag: its size says little
                    out.append({"text": part, "rect": pr, "src": "text", "joined": len(parts) > 1})
    for a in page.annots() or []:
        c = _clean((a.info or {}).get("content") or "")
        if c and len(c) <= MAX_LABEL and re.search(r"\d", c) and " " not in c:
            out.append({"text": c, "rect": fitz.Rect(a.rect), "src": "markup"})
    # CAD often prints a tag twice on top of itself (two layers): that is one label
    kept = []
    for l in out:
        if not any(k["text"] == l["text"] and abs(k["rect"].x0 - l["rect"].x0) < 1 and abs(k["rect"].y0 - l["rect"].y0) < 1 for k in kept):
            kept.append(l)
    out = kept
    for i, l in enumerate(out):
        r = l["rect"]
        l.update(id=f"{file_no}.{page_no}.{i}", file=file_no, page=page_no,
                 size=round(min(r.width, r.height) if l["src"] == "text" else r.height, 2))
    return out


def _split_joined(text: str, rect):
    """Two labels printed touching come out as one word: 'BT0-105/3BT0-106/1', '00180019'.
    A word that cuts into two halves of the same shape is split back into two."""
    best = None
    for cut in range(2, len(text) - 1):
        a, b = text[:cut], text[cut:]
        ka, kb = shape_key(a), shape_key(b)
        if ka and ka == kb and re.search(r"\d", a) and re.search(r"\d", b) and len(a) >= 2 and len(b) >= 2:
            if best is None or abs(cut - len(text) / 2) < abs(best - len(text) / 2):
                best = cut
    if best is None or shape_key(text) and len(text) <= 6:
        return [(text, rect)]
    a, b = text[:best], text[best:]
    f = len(a) / len(text)
    if rect.width >= rect.height:
        ra = fitz.Rect(rect.x0, rect.y0, rect.x0 + rect.width * f, rect.y1)
        rb = fitz.Rect(ra.x1, rect.y0, rect.x1, rect.y1)
    else:
        ra = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + rect.height * f)
        rb = fitz.Rect(rect.x0, ra.y1, rect.x1, rect.y1)
    return [(a, ra), (b, rb)]


def _extends(k: str, p: str) -> bool:
    """Shape k is shape p with a little more on the end: a leaf number (D1-645/3
    beside D1-644) or a letter (SD16A, a door added beside SD16)."""
    if len(p) >= len(k) or not k.startswith(p):
        return False
    rest = k[len(p):]
    # not I, L, O or Q: those are a 1 or a 0 printed wrong (W-04I), not a door added (SD16A)
    return bool(re.fullmatch(r"([^A-Z#]#)+", rest) or (p.endswith("#") and re.fullmatch(r"[A-HJKMNPR-Z]{1,2}", rest)))


def shape_key(text: str) -> str | None:
    """DG.27 -> 'DG.#', D1-645/3 -> 'D#-#/#', 1234 -> '#4' (all-digit labels keep their length).
    None for things that are never door tags: dates, times, levels, measurements."""
    t = text.upper()
    if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{2,4}", t) or re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", t):
        return None
    if re.fullmatch(r"[+-]?\d+([.,]\d+)?", t):
        if not re.fullmatch(r"\d+", t):
            return None                                  # 1127.5, +62.760
        return f"#{len(t)}"
    if re.search(r"(MM|M2|SQM|M²|KG|DB|%)$", t):
        return None
    if re.search(r"[.,:;)]$", t) or t.startswith("("):
        return None                                      # list numbers in notes: 5. 12) (3)
    return re.sub(r"\d+", "#", t)


def _numbers(text: str) -> list[int]:
    return [int(x) for x in re.findall(r"\d+", text)]


# ── Doors drawn on the plan ───────────────────────────────────────────────────
def _arc_from_bezier(p0, c1, c2, p3):
    """Centre, radius and turn of a circular arc drawn as one curve, or None."""
    t0 = (c1.x - p0.x, c1.y - p0.y)
    t3 = (p3.x - c2.x, p3.y - c2.y)
    if math.hypot(*t0) < 1e-6 or math.hypot(*t3) < 1e-6:
        return None
    # the centre is where the normals at both ends meet
    n0, n3 = (-t0[1], t0[0]), (-t3[1], t3[0])
    det = n0[0] * (-n3[1]) - n0[1] * (-n3[0])
    if abs(det) < 1e-9:
        return None
    dx, dy = p3.x - p0.x, p3.y - p0.y
    s = (dx * (-n3[1]) - dy * (-n3[0])) / det
    cx, cy = p0.x + s * n0[0], p0.y + s * n0[1]
    r0, r3 = math.hypot(p0.x - cx, p0.y - cy), math.hypot(p3.x - cx, p3.y - cy)
    if r0 < 2 or abs(r0 - r3) > 0.08 * r0:
        return None
    a0, a3 = math.atan2(p0.y - cy, p0.x - cx), math.atan2(p3.y - cy, p3.x - cx)
    turn = abs((a3 - a0 + math.pi) % (2 * math.pi) - math.pi)
    return cx, cy, (r0 + r3) / 2, turn


def _arcs_from_lines(segs) -> list:
    """Arcs drawn as a run of short straight lines, end to end, each turning the
    same way a little: some CAD exports draw every door swing like that."""
    key = lambda p: (round(p.x * 2), round(p.y * 2))
    ends = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        ends[key(a)].append(i); ends[key(b)].append(i)
    used, out = set(), []
    for i in range(len(segs)):
        if i in used:
            continue
        used.add(i)
        chain = [segs[i][0], segs[i][1]]
        for side in (1, 0):                          # grow from the far end, then the near end
            while True:
                tip = chain[-1] if side else chain[0]
                nxt = None
                for j in ends.get(key(tip), ()):
                    if j in used:
                        continue
                    a, b = segs[j]
                    other = b if key(a) == key(tip) else a
                    nxt = (j, other); break
                if nxt is None:
                    break
                used.add(nxt[0])
                if side:
                    chain.append(nxt[1])
                else:
                    chain.insert(0, nxt[1])
                if len(chain) > 80:
                    break
        if len(chain) < 5:
            continue
        p0, pm, p1 = chain[0], chain[len(chain) // 2], chain[-1]
        # the circle through the two ends and the middle
        ax, ay, bx, by, cx_, cy_ = p0.x, p0.y, pm.x, pm.y, p1.x, p1.y
        d = 2 * (ax * (by - cy_) + bx * (cy_ - ay) + cx_ * (ay - by))
        if abs(d) < 1e-6:
            continue
        ux = ((ax * ax + ay * ay) * (by - cy_) + (bx * bx + by * by) * (cy_ - ay) + (cx_ * cx_ + cy_ * cy_) * (ay - by)) / d
        uy = ((ax * ax + ay * ay) * (cx_ - bx) + (bx * bx + by * by) * (ax - cx_) + (cx_ * cx_ + cy_ * cy_) * (bx - ax)) / d
        r = math.hypot(ax - ux, ay - uy)
        if r < 3 or any(abs(math.hypot(p.x - ux, p.y - uy) - r) > 0.04 * r for p in chain):
            continue
        turn = 0.0
        for a, b in zip(chain, chain[1:]):
            t = math.atan2(b.y - uy, b.x - ux) - math.atan2(a.y - uy, a.x - ux)
            turn += (t + math.pi) % (2 * math.pi) - math.pi
        out.append((ux, uy, r, abs(turn)))
    return out


_SCALES = {20, 25, 50, 75, 100, 125, 200, 250, 500}


def _door_size_at_scale(page) -> float:
    """A door leaf's width in points at the sheet's printed scale (1:50, 1 : 100), or 0."""
    try:
        text = " ".join(page.get_text().split())
    except Exception:
        return 0.0
    found = Counter(int(n) for n in re.findall(r"\b1\s?:\s?(\d{2,3})\b", text) if int(n) in _SCALES)
    if not found:
        return 0.0
    scale = found.most_common(1)[0][0]
    return 850 / scale * 72 / 25.4


def _door_geometry(page) -> tuple[list, list, float]:
    """(door swings as rectangles, highlighted line segments, typical door width in points)."""
    try:
        drawings = page.get_drawings()
    except Exception:
        return [], [], 0.0
    pieces = []
    coloured = []
    short = []
    for d in drawings:
        col = d.get("color")
        sat = (max(col) - min(col)) if col else 0
        for it in d.get("items", []):
            if it[0] == "c":
                arc = _arc_from_bezier(*it[1:5])
                if arc:
                    pieces.append(arc)
            elif it[0] == "l":
                if sat > 0.35:
                    coloured.append((it[1], it[2]))
                if 0.2 < math.hypot(it[2].x - it[1].x, it[2].y - it[1].y) < 25:
                    short.append((it[1], it[2]))
    if len(short) < 200000:
        pieces += _arcs_from_lines(short)
    # pieces of one arc share a centre and radius: add their turns together. A
    # whole circle (a grid bubble, a column) comes to far more than a door's turn.
    groups = []                                      # [cx, cy, r, turn]
    cells = defaultdict(list)
    for cx, cy, r, turn in pieces:
        q = max(1.0, r * 0.06)
        qc = max(0.3, r * 0.025)                     # pieces of one circle share its centre closely
        key = (round(cx / 8), round(cy / 8))
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for g in cells.get((key[0] + dx, key[1] + dy), ()):
                    if abs(g[0] - cx) <= qc and abs(g[1] - cy) <= qc and abs(g[2] - r) <= q:
                        hit = g; break
                if hit: break
            if hit: break
        if hit:
            hit[3] += turn
        else:
            g = [cx, cy, r, turn]
            groups.append(g); cells[key].append(g)
    swings = []
    for cx, cy, r, turn in groups:
        deg = math.degrees(turn)
        if 70 <= deg <= 110:                          # a door opening through about a right angle
            swings.append((cx, cy, r))
    if len(swings) < 3:
        door_w = 0.0
    else:
        # the most common swing size is the door size; furniture and the odd
        # drawn curve fall either side of it
        bins = Counter(round(math.log(r, 1.25)) for _, _, r in swings if 3 < r < 200)
        if not bins:
            return [], [], 0.0
        mode = bins.most_common(1)[0][0]
        # where the sheet gives its scale, a door leaf (about 850 mm) has a known
        # size on paper: take the commonest swing near it, not the chairs and bins
        want = _door_size_at_scale(page)
        if want:
            near = {b: n for b, n in bins.items() if 0.55 * want <= 1.25 ** b <= 1.6 * want and n >= 2}
            if near:
                mode = max(near, key=lambda b: (near[b], -abs(1.25 ** b - want)))
        door_w = 1.25 ** mode
        swings = [s for s in swings if 0.45 * door_w <= s[2] <= 2.2 * door_w]
    rects = [fitz.Rect(cx - r, cy - r, cx + r, cy + r) for cx, cy, r in swings]
    if door_w:
        coloured = [s for s in coloured if 0.5 * door_w <= math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) <= 4 * door_w]
    return rects, coloured, door_w


def _dist_rect(a, b) -> float:
    dx = max(b.x0 - a.x1, a.x0 - b.x1, 0)
    dy = max(b.y0 - a.y1, a.y0 - b.y1, 0)
    return math.hypot(dx, dy)


def _dist_seg(r, p, q) -> float:
    cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
    vx, vy = q.x - p.x, q.y - p.y
    L = vx * vx + vy * vy or 1e-9
    t = max(0, min(1, ((cx - p.x) * vx + (cy - p.y) * vy) / L))
    d = math.hypot(cx - (p.x + t * vx), cy - (p.y + t * vy))
    return max(0.0, d - max(r.width, r.height) / 2)


# ── The drawing key ───────────────────────────────────────────────────────────
_DOOR_WORD = re.compile(r"\b(door|doors|dr|doorset|doorsets)\b", re.I)


def _key_entries(page, labels) -> set:
    """Labels printed as an example in a key: 'AD000  Automatic Doors', or inside a KEY/LEGEND box."""
    words = page.get_text("words")
    out = set()
    titles = [fitz.Rect(w[:4]) for w in words if re.fullmatch(r"(KEY|LEGEND|NOTES?)[:.]?", w[4].strip(), re.I)]
    for l in labels:
        r = l["rect"]
        h = max(r.height, 4)
        line = " ".join(w[4] for w in words if abs((w[1] + w[3]) / 2 - (r.y0 + r.y1) / 2) < h * 0.6
                        and 0 < w[0] - r.x1 < h * 12)
        if _DOOR_WORD.search(line) and len(re.findall(r"[A-Za-z]{3,}", line)) >= 1:
            out.add(l["id"])
        elif any(0 <= r.y0 - t.y1 < h * 30 and abs(r.x0 - t.x0) < h * 15 for t in titles):
            out.add(l["id"])
    return out


# ── Families ──────────────────────────────────────────────────────────────────
def _sequence_score(texts: list[str]) -> float:
    """How much the numbers run on from one another (D01, D02, D03 ...)."""
    groups = defaultdict(set)
    for t in texts:
        nums = re.findall(r"\d+", t)
        if not nums:
            continue
        stem = re.sub(r"\d+(?=\D*$)", "#", t)
        groups[stem].add(int(nums[-1]))
    have = total = 0
    for vals in groups.values():
        for v in vals:
            total += 1
            have += (v - 1 in vals) or (v + 1 in vals)
    return have / total if total else 0.0


def _size_groups(ls: list[dict]) -> list[list[dict]]:
    """Labels of one shape split by text size: door tags are all printed the same size."""
    ls = sorted(ls, key=lambda l: l["size"])
    groups = [[ls[0]]] if ls else []
    for l in ls[1:]:
        if l["size"] <= groups[-1][0]["size"] * 1.15:
            groups[-1].append(l)
        else:
            groups.append([l])
    return groups


def _families(labels: list[dict], near: dict, key_ids: set, has_geo: bool) -> list[dict]:
    by_key = defaultdict(list)
    for l in labels:
        k = shape_key(l["text"])
        if k:
            by_key[k].append(l)
    # D#-#/# joins D#-# when it only adds a trailing number: D1-645/3 beside D1-644
    keys = sorted(by_key, key=len)
    parent = {}
    for k in keys:
        for p in keys:
            if p != k and _extends(k, p):
                parent[k] = parent.get(p, p)
                break
    merged = defaultdict(list)
    for k, ls in by_key.items():
        merged[parent.get(k, k)].extend(ls)
    fams = []
    for k0, ls0 in merged.items():
        numeric = bool(re.fullmatch(r"#\d+", k0))
        # on each sheet the tags of one style are printed one size; sizes may differ
        # from sheet to sheet, so the door-like size group is picked sheet by sheet
        per_sheet = defaultdict(list)
        for l in ls0:
            per_sheet[(l["file"], l["page"])].append(l)
        ls = []
        for sl in per_sheet.values():
            best = None
            for g in _size_groups(sl):
                gr = [l for l in g if l["id"] not in key_ids]
                if numeric:
                    keep = _dense([int(l["text"]) for l in gr if l["text"].isdigit()])
                    gr = [l for l in gr if l["text"].isdigit() and int(l["text"]) in keep]
                u = len({l["text"].upper() for l in gr})
                nr = sum(1 for l in gr if near.get(l["id"])) / max(1, len(gr))
                val = u * ((0.2 + 0.8 * nr) if has_geo else 1.0)
                if best is None or val > best[0]:
                    best = (val, g, gr)
            if best and best[2]:
                ls += best[1]
                # tags split out of a touching pair keep the size of the pair's box
                gs = sorted(l["size"] for l in best[1])
                mid = gs[len(gs) // 2]
                ls += [l for l in sl if l.get("joined") and l not in best[1] and 0.6 * mid <= l["size"] <= 1.8 * mid]
        k = k0
        real = [l for l in ls if l["id"] not in key_ids]
        if numeric:
            keep = _dense([int(l["text"]) for l in real if l["text"].isdigit()])
            real = [l for l in real if l["text"].isdigit() and int(l["text"]) in keep]
        texts = [l["text"].upper() for l in real]
        n = len(set(texts))
        if n < 2:
            continue
        uniq = n / max(1, len(texts))
        seq = _sequence_score(texts)
        geo = sum(1 for l in real if near.get(l["id"])) / max(1, len(real)) if has_geo else None
        keyed = any(l["id"] in key_ids for l in ls)
        score = math.log(1 + n) * (0.5 + 0.5 * uniq) * (0.55 + 0.45 * seq)
        score *= (0.2 + 0.8 * geo) if geo is not None else 0.6
        score *= 1.8 if keyed else 1.0
        score *= 0.6 if numeric else 1.0
        example = sorted(texts)[len(texts) // 2]
        fams.append({"key": k, "members": {l["id"] for l in real} | {l["id"] for l in ls if l["id"] in key_ids},
                     "example": example, "count": n, "unique": round(uniq, 2), "sequence": round(seq, 2),
                     "at_doors": None if geo is None else round(geo, 2), "in_key": keyed, "score": round(score, 3)})
    fams.sort(key=lambda f: -f["score"])
    return fams


def _split_fam(f: str) -> tuple[str, float]:
    return f.partition("~")[0], 0.0


def family_of(text: str, keys: list[str], size: float = 0.0) -> str | None:
    """Which chosen family a label belongs to: its shape (or one it extends by a
    trailing number, D1-645/3 beside D1-644) and, when known, its text size."""
    k = shape_key(text)
    if not k:
        return None
    for f in keys:
        shape, fs = _split_fam(f)
        if k == shape or _extends(k, shape):
            return f
    return None


def _dense(values: list[int]) -> set:
    """Numbers that sit in a run of at least three close neighbours: door numbers, not dimensions."""
    vs = sorted(set(values))
    keep, run = set(), [vs[0]] if vs else []
    for a, b in zip(vs, vs[1:]):
        if b - a <= 3:
            run.append(b)
        else:
            if len(run) >= 3:
                keep |= set(run)
            run = [b]
    if len(run) >= 3:
        keep |= set(run)
    return keep


_CONFUSE = str.maketrans({"I": "1", "L": "1", "|": "1", "O": "0", "Q": "0"})


def _near_miss(text: str, keys: list[str]) -> str | None:
    """A label that is one slip away from a chosen family: DI-659/3 for D1-659/3, 'D 12' for D12."""
    t = text.upper()
    for f in keys:
        shape = _split_fam(f)[0]
        n = re.fullmatch(r"#(\d+)", shape)
        if n and t.isdigit() and len(t) > int(n.group(1)):
            # an all-number tag printed into another number: '9610040' holding 0040
            w = int(n.group(1))
            for c in (t[-w:], t[:w]):
                if c != t:
                    return c
            continue
        lead = re.match(r"[A-Z]*", shape).group(0)
        body = t[len(lead):] if t.startswith(lead) else None
        cands = []
        if body is not None:
            cands.append(lead + body.translate(_CONFUSE))
        cands.append(t.replace(" ", ""))
        for c in cands:
            if c != t and family_of(c, [shape]):
                return c
    return None


# ── The reading ───────────────────────────────────────────────────────────────
_FLOORS = "BASEMENT|LOWER GROUND|UPPER GROUND|GROUND|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ROOF|MEZZANINE"


def _floor_of(page, file_name: str) -> str:
    text = " ".join(page.get_text().split()).upper()
    # a sheet title says it best: "THIRD FLOOR PLAN", "LEVEL 3 PLAN", "THIRD FLOOR AUTOMATIC DOORS"
    title = re.findall(rf"\b({_FLOORS})\s+FLOOR\b(?=\s+(?:GA\s+|GENERAL\s+ARRANGEMENT\s+|LAYOUT\s+)?PLAN|\s+\w+\s+DOORS|\s+DOOR)", text)
    title += [f"LEVEL {int(n)}" for n in re.findall(r"\bLEVEL\s+(-?\d{1,2})\s+(?:FLOOR\s+)?(?:GA\s+)?PLAN\b", text)]
    if title:
        top = Counter(title).most_common(1)[0][0]
        return top.title() if top.startswith("LEVEL") else f"{top.title()} Floor"
    by_name = floor_from_name(file_name)
    if by_name:
        return by_name if " " in by_name or by_name.upper() in ("ROOF", "BASEMENT", "MEZZANINE") else f"{by_name} Floor"
    hits = re.findall(r"\b(BASEMENT|LOWER GROUND|GROUND|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ROOF|MEZZANINE)\s+(?:FLOOR|LEVEL)\b", text)
    # "stairs to level 1", "from levels -1": directions on the drawing, not this sheet's floor
    hits += [f"LEVEL {int(n)}" for n in re.findall(r"(?<!TO )(?<!FROM )(?<!UPPER )(?<!LOWER )\bLEVEL\s+(-?\d{1,2})\b(?!\s*&)", text)]
    if hits:
        top = Counter(hits).most_common(1)[0][0]
        return top.title() if top.startswith("LEVEL") else f"{top.title()} Floor"
    return ""


def read_plans(files: list[tuple[str, bytes]], keys: list[str] | None = None) -> dict:
    """
    files: (file name, pdf bytes). keys: the door tag families to use; None
    chooses the best one. Returns pages, the families found, and every door
    with its status: green (sure), amber (for a person to look at) or out
    (in the drawing key).
    """
    pages, labels, near, key_ids = [], [], {}, set()
    geo_pages = 0
    problems = []
    for fno, (name, data) in enumerate(files):
        try:
            doc = fitz.open(stream=data, filetype="pdf")
        except Exception:
            problems.append({"file": fno, "name": name, "problem": "This file is not a PDF that can be opened."})
            continue
        for pno in range(len(doc)):
            page = doc[pno]
            words = page.get_text("words")
            info = {"file": fno, "page": pno + 1, "name": name, "width": page.rect.width, "height": page.rect.height,
                    "floor": _floor_of(page, name), "readable": len(words) >= 25}
            if not info["readable"]:
                info["problem"] = "No text to read on this sheet: it looks like a scan or a picture. Ask for the plan exported from CAD."
                pages.append(info)
                continue
            ls = _labels(page, pno + 1, fno)
            swings, lines, door_w = _door_geometry(page)
            key_ids |= _key_entries(page, ls)
            if page.rotation:
                # text and drawings come in the sheet's own frame; the sheet is shown turned
                m = page.rotation_matrix
                for l in ls:
                    l["rect"] = l["rect"] * m
                swings = [r * m for r in swings]
                lines = [(fitz.Point(a) * m, fitz.Point(b) * m) for a, b in lines]
            info["door_width"] = round(door_w, 1)
            info["swings"] = len(swings)
            if swings or lines:
                geo_pages += 1
            reach = (door_w or 20) * NEAR_DOOR
            for l in ls:
                r = l["rect"]
                at_swing = any(_dist_rect(r, s) <= reach * 0.6 for s in swings)
                at_line = any(_dist_seg(r, p, q) <= reach for p, q in lines)
                near[l["id"]] = at_swing or at_line
                l["floor"] = info["floor"]
            info["_swings"] = swings
            pages.append(info)
            labels.extend(ls)
        doc.close()

    has_geo = geo_pages > 0
    fams = _families(labels, near, key_ids, has_geo)
    chosen = keys if keys else _auto_choose(fams, pages)
    if not keys:
        chosen += _companions(fams, chosen, {l["id"]: l for l in labels})
    return _check(pages, labels, near, key_ids, fams, chosen, has_geo, problems)


def _lead(key: str) -> str:
    m = re.match(r"[A-Z]+", key)
    return m.group(0) if m else ""


def _companions(fams: list[dict], chosen: list[str], by_id: dict) -> list[str]:
    """Other door tag styles printed alongside the chosen one: ED9 and BD1 beside
    D20, FD12 beside D3. Both end in D (door), are printed the same size on the
    same sheet, and have the same plain shape of letters and a number."""
    extra = []
    for c in chosen:
        top = next((f for f in fams if f["key"] == c), None)
        lead = _lead(c)
        # D for door: D, ED, BD, FD, SD, AD are door tags whatever the architect
        if not top or not lead.endswith("D") or not re.fullmatch(r"[A-Z]{1,3}[-./]?#", c):
            continue
        sizes = defaultdict(list)
        for i in top["members"]:
            l = by_id.get(i)
            if l:
                sizes[(l["file"], l["page"])].append(l["size"])
        for f in fams:
            k = f["key"]
            if k in chosen or k in extra or not re.fullmatch(r"[A-Z]{1,3}[-./]?#", k):
                continue
            fl = _lead(k)
            if fl == lead or not fl.endswith(lead[-1]) or len(fl) > len(lead) + 1:
                continue
            ok = 0
            for i in f["members"]:
                l = by_id.get(i)
                ss = sizes.get((l["file"], l["page"])) if l else None
                if ss and abs(l["size"] - sorted(ss)[len(ss) // 2]) <= 0.05 * l["size"]:
                    ok += 1
            if ok >= 2 and ok >= 0.8 * len(f["members"]):
                extra.append(k)
    return extra


def _sheet_of(label_id: str) -> tuple[int, int]:
    f, p, _ = label_id.split(".", 2)
    return int(f), int(p)


def _auto_choose(fams: list[dict], pages: list[dict]) -> list[str]:
    """The best style, and for any sheet it does not reach (plans from another
    architect in the same upload) the best style on that sheet."""
    if not fams:
        return []
    chosen = [fams[0]["key"]]
    covered = {_sheet_of(i) for i in fams[0]["members"]}
    top = fams[0]["score"]
    for p in pages:
        sh = (p["file"], p["page"])
        if not p.get("readable") or sh in covered:
            continue
        for f in fams[1:]:
            on = {i for i in f["members"] if _sheet_of(i) == sh}
            if len(on) >= 5 and f["score"] >= 0.25 * top and (f["at_doors"] is None or f["at_doors"] >= 0.3):
                if f["key"] not in chosen:
                    chosen.append(f["key"])
                covered |= {_sheet_of(i) for i in f["members"]}
                break
    return chosen


def _check(pages, labels, near, key_ids, fams, chosen, has_geo, problems) -> dict:
    doors, items = [], []
    fam_rate = {f["key"]: f["at_doors"] for f in fams}
    page_size = {(p["file"], p["page"]): (p["width"], p["height"]) for p in pages}
    multi = Counter(p["file"] for p in pages)
    sheet_name = {(p["file"], p["page"]): p["name"].rsplit(".", 1)[0] + (f", page {p['page']}" if multi[p["file"]] > 1 else "")
                  for p in pages}
    chosen = [_split_fam(c)[0] for c in chosen]
    members = set()
    for f in fams:
        if f["key"] in chosen:
            members |= f["members"]
    known = {f["key"] for f in fams}
    # a style picked by hand that was too small to rank still counts, by its shape
    mine = [l for l in labels if l["id"] in members
            or (family_of(l["text"], [c for c in chosen if c not in known]) and l["id"] not in key_ids)]
    # Two sheets with the same tags in the same places show one floor twice: one copy
    # counts. The same tags in different places means each floor starts its numbers
    # again, and the floor tells the doors apart.
    by_sheet = defaultdict(dict)
    for l in mine:
        W, H = page_size[(l["file"], l["page"])]
        by_sheet[(l["file"], l["page"])][l["text"].upper()] = (l["rect"].x0 / W, l["rect"].y0 / H)
    same_as, restart = {}, set()
    sheets = sorted(by_sheet)
    for i, a in enumerate(sheets):
        for b in sheets[:i]:
            if b in same_as:
                continue
            common = set(by_sheet[a]) & set(by_sheet[b])
            if len(common) < 0.4 * min(len(by_sheet[a]), len(by_sheet[b])):
                continue
            # the same drawing, perhaps moved on the sheet: the tags keep their places
            # relative to one another, whatever the shift
            offs = [(by_sheet[a][t][0] - by_sheet[b][t][0], by_sheet[a][t][1] - by_sheet[b][t][1]) for t in common]
            mx = sorted(o[0] for o in offs)[len(offs) // 2]
            my = sorted(o[1] for o in offs)[len(offs) // 2]
            placed = sum(1 for ox, oy in offs if abs(ox - mx) < 0.02 and abs(oy - my) < 0.02)
            if placed >= 0.6 * len(common):
                same_as[a] = b
                break
            restart |= {a, b}
    seen = {}
    lengths = defaultdict(Counter)
    at = defaultdict(lambda: [0, 0])
    for l in mine:
        f = family_of(l["text"], chosen)
        lengths[f][tuple(len(x) for x in re.findall(r"\d+", l["text"]))] += 1
        a = at[(f, l["file"], l["page"])]
        a[0] += 1 if near.get(l["id"]) else 0
        a[1] += 1
    sheet_rate = {k: v[0] / v[1] for k, v in at.items() if v[1] >= 5}
    for l in mine:
        f = family_of(l["text"], chosen)
        text = l["text"].upper()
        sheet = (l["file"], l["page"])
        ref = l["text"]
        if sheet in restart:
            # numbers start again on each floor: the floor makes the reference unique
            fl = l.get("floor") or f"sheet {l['page']}"
            ref, text = f"{l['text']} ({fl})", f"{text} ({fl.upper()})"
        door = {"id": l["id"], "ref": ref, "file": l["file"], "page": l["page"], "floor": l.get("floor", ""),
                "x": l["rect"].x0, "y": l["rect"].y0, "w": l["rect"].width, "h": l["rect"].height,
                "family": f, "src": l["src"], "status": "green", "reasons": []}
        if l["id"] in key_ids or (re.search(r"\d", text) and all(int(x) == 0 for x in re.findall(r"\d+", text))):
            door["status"], door["reasons"] = "out", ["An example in the drawing key, not a door"]
            doors.append(door); continue
        if sheet in same_as and l["text"].upper() in by_sheet[same_as[sheet]]:
            door["status"], door["reasons"] = "out", [f"Also on sheet {same_as[sheet][1]}: this sheet repeats part of it"]
            doors.append(door); continue
        if text in seen:
            first = seen[text]
            other = (first["file"], first["page"])
            where = sheet_name.get(other, f"sheet {first['page']}")
            if other != sheet and first["floor"] and first["floor"] == door["floor"]:
                # plans of one floor in parts overlap at the edges: the door is already counted
                door["status"], door["reasons"] = "out", [f"Also on {where}: the plans overlap here, so it is counted once"]
                doors.append(door); continue
            door["status"], door["reasons"] = "amber", [f"{l['text']} is printed twice: also on {where}" if other != sheet else f"{l['text']} is printed twice on this sheet"]
        else:
            seen[text] = door
        usual = lengths[f].most_common(1)[0][0]
        digits = tuple(len(x) for x in re.findall(r"\d+", text))
        if len(digits) == len(usual) and digits != usual and lengths[f][usual] >= 3 * lengths[f][digits]:
            door["status"] = "amber"; door["reasons"].append("Its number has a different number of digits from the rest")
        rate = sheet_rate.get((f, l["file"], l["page"]), fam_rate.get(f))
        if has_geo and rate is not None and rate >= STRAY_RELIABLE and not near.get(l["id"]):
            door["status"] = "amber"; door["reasons"].append("Not next to a door on the drawing: may be a room or other label")
        doors.append(door)

    # near misses: one slip from a chosen family
    taken = {l["id"] for l in mine}
    slips = set()
    for l in labels:
        if l["id"] in taken or family_of(l["text"], chosen) or l["id"] in key_ids:
            continue
        fixed = _near_miss(l["text"], chosen)
        sh = (l["file"], l["page"])
        if fixed and fixed.upper() in slips:
            continue                          # the same slip on a sheet repeated
        if fixed and not (sh in same_as and fixed.upper() in by_sheet[same_as[sh]]) and fixed.upper() not in {m["text"].upper() for m in mine}:
            slips.add(fixed.upper())
            doors.append({"id": l["id"], "ref": fixed, "printed": l["text"], "file": l["file"], "page": l["page"],
                          "floor": l.get("floor", ""), "x": l["rect"].x0, "y": l["rect"].y0, "w": l["rect"].width, "h": l["rect"].height,
                          "family": None, "src": l["src"], "status": "amber",
                          "reasons": [f"Printed as {l['text']}: looks like a door tag with a slip. Read as {fixed}"]})

    # the safety net: a label in another style right at a drawn door, on a sheet where
    # the door tags do sit at doors, may be a door tag the chosen style left out
    counted_ids = {d["id"] for d in doors}
    tagged_at = {}
    for (f_, fi, pg), rt in sheet_rate.items():
        tagged_at[(fi, pg)] = max(tagged_at.get((fi, pg), 0), rt)
    others = defaultdict(list)
    for l in labels:
        sh = (l["file"], l["page"])
        if l["id"] in counted_ids or l["id"] in key_ids or not near.get(l["id"]) or tagged_at.get(sh, 0) < GEO_RELIABLE:
            continue
        if not re.fullmatch(r"[A-Z]{1,4}[-./_]?\d{1,4}[A-Z]?", l["text"].upper()) or family_of(l["text"], chosen):
            continue
        if sh in same_as:
            continue
        others[sh].append(l)
    other_note = {}
    for sh, ls in others.items():
        mine_here = sum(1 for d in doors if (d["file"], d["page"]) == sh)
        # a few are worth a look; many are a whole other kind of label (windows, rooms)
        if len(ls) <= max(3, 0.15 * mine_here):
            for l in ls:
                doors.append({"id": l["id"], "ref": l["text"], "file": l["file"], "page": l["page"], "floor": l.get("floor", ""),
                              "x": l["rect"].x0, "y": l["rect"].y0, "w": l["rect"].width, "h": l["rect"].height,
                              "family": None, "src": l["src"], "status": "amber", "other_style": True,
                              "reasons": [f"{l['text']} sits at a door but is not in the door tag style. A door tag in another style?"]})
        else:
            other_note[sh] = (len(ls), sorted({l["text"] for l in ls})[:3])

    # gaps in dense numbering, across every sheet
    counted = [d for d in doors if d["status"] != "out" and not d.get("other_style")]
    groups = defaultdict(dict)
    for d in counted:
        t = d["ref"].upper()
        m = re.search(r"(\d+)(\D*)$", t)
        if m:
            groups[(t[:m.start(1)], m.group(2), len(m.group(1)))][int(m.group(1))] = d
    all_refs = {d["ref"].upper() for d in counted}
    runs = []
    for (head, tail, width), vals in groups.items():
        # SD15..SD34 then SD54, SD55: each close run is checked on its own
        ns = sorted(vals)
        run = [ns[0]] if ns else []
        for a, b in zip(ns, ns[1:]):
            if b - a <= 10:
                run.append(b)
            else:
                runs.append((head, tail, width, vals, run)); run = [b]
        if run:
            runs.append((head, tail, width, vals, run))
    for head, tail, width, vals, run in runs:
        if len(run) < 4:
            continue
        lo, hi = run[0], run[-1]
        span = hi - lo + 1
        if span > 400 or len(run) < 0.8 * span:
            continue
        near_doc = vals[lo]
        for v in range(lo, hi + 1):
            if v in vals:
                continue
            ref = f"{head}{v:0{width}d}{tail}"
            if any(r.startswith(ref) and len(r) > len(ref) and not r[len(ref)].isalnum() for r in all_refs):
                continue                      # D1-645 is covered by D1-645/2, D1-645/3
            nb = vals.get(v - 1) or vals.get(v + 1) or near_doc
            items.append({"id": f"gap.{ref}", "kind": "gap", "ref": ref, "file": nb["file"], "page": nb["page"],
                          "floor": nb["floor"], "x": nb["x"], "y": nb["y"], "w": nb["w"], "h": nb["h"], "status": "amber",
                          "reasons": [f"No {ref} on the plans, between {head}{v - 1:0{width}d}{tail} and {head}{v + 1:0{width}d}{tail}. A door may be missing its tag."]})

    # doors drawn with no tag, where tags reliably sit at doors
    untagged_note = {}
    if True:
        for p in pages:
            sw = p.get("_swings") or []
            if not sw:
                continue
            sheet = (p["file"], p["page"])
            if sheet in same_as:
                continue
            # only where this sheet's tags sit at drawn swings: a sheet that marks its
            # doors another way (a coloured line) says nothing about its bare swings
            sr = p.get("_swings")
            reach0 = (p.get("door_width") or 20) * NEAR_DOOR
            here = [d for d in counted if (d["file"], d["page"]) == sheet and d.get("family")]
            at_sw = sum(1 for d in here if any(_dist_rect(fitz.Rect(d["x"], d["y"], d["x"] + d["w"], d["y"] + d["h"]), s) <= reach0 * 0.6 for s in sr))
            if len(here) < 5 or at_sw < GEO_RELIABLE * len(here):
                continue
            # every tag printed here marks its door, counted on this sheet or another
            tags = [fitz.Rect(d["x"], d["y"], d["x"] + d["w"], d["y"] + d["h"]) for d in doors
                    if (d["file"], d["page"]) == sheet]
            reach = (p.get("door_width") or 20) * NEAR_DOOR
            bare = [s for s in sw if not any(_dist_rect(t, s) <= reach for t in tags)]
            # a few bare swings are worth a look; a plan with many is one where only
            # some doors are tagged (the automatic doors, say), so it is noted once
            if bare and len(bare) <= max(3, 0.25 * len(tags)):
                for i, s in enumerate(bare):
                    items.append({"id": f"bare.{p['file']}.{p['page']}.{i}", "kind": "untagged", "ref": "", "file": p["file"],
                                  "page": p["page"], "floor": p["floor"], "x": s.x0, "y": s.y0, "w": s.width, "h": s.height,
                                  "status": "amber", "reasons": ["A door is drawn here with no tag"]})
            elif bare:
                untagged_note[f"{p['file']}.{p['page']}"] = len(bare)

    for p in pages:
        p.pop("_swings", None)
        n = untagged_note.get(f"{p['file']}.{p['page']}")
        if n:
            p["note"] = f"{n} other doors on this sheet have no tag in this style, so only the tagged doors are counted."
        o_ = other_note.get((p["file"], p["page"]))
        if o_:
            p["note"] = ((p.get("note") or "") + f" {o_[0]} labels in other styles sit at doors ({', '.join(o_[1])}). "
                         "If those are door tags, add their style above.").strip()

    green = sum(1 for d in doors if d["status"] == "green")
    amber = sum(1 for d in doors if d["status"] == "amber") + len(items)
    out_fams = [{k: v for k, v in f.items() if k != "members"} for f in fams[:12]]
    return {"pages": pages, "families": out_fams, "chosen": chosen, "doors": doors, "checks": items,
            "problems": problems, "restarts": bool(restart), "totals": {"green": green, "amber": amber,
                                             "out": sum(1 for d in doors if d["status"] == "out")}}


def labels_at(files: list[tuple[str, bytes]], file_no: int, page_no: int) -> list[dict]:
    """Every label on one sheet, for picking a style by clicking one."""
    name, data = files[file_no]
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        page = doc[page_no - 1]
        ls = _labels(page, page_no, file_no)
        for l in ls:
            l["rect"] = l["rect"] * page.rotation_matrix
        return [{"id": l["id"], "text": l["text"], "key": shape_key(l["text"]), "x": l["rect"].x0, "y": l["rect"].y0,
                 "w": l["rect"].width, "h": l["rect"].height} for l in ls if shape_key(l["text"])]
    finally:
        doc.close()
