"""
Read an Intec schedule PDF (priced or unpriced) and turn it into the app's
own data: the products it names, the hardware sets it lists, and the job
itself as a project with its doors. This is how years of old quotes become
the starting library, instead of typing every set again.
"""
import re
from datetime import datetime

try:
    import pymupdf as fitz
except ImportError:
    import fitz

import models

_UNIT = re.compile(r"^[A-Z]{2,6}$")           # EACH, ITEM, PAIR, SET, M, ROLL
_NUM = re.compile(r"^\d+(?:\.\d+)?$")
_INT = re.compile(r"^\d+$")
_DOORS = re.compile(r"^(\d+)\s+Doors?(?:\s*@)?$")
_REF = re.compile(r"^[A-Z]{1,3}[-_]?\d{1,4}(?:[-.]\d{1,4})*[A-Za-z]?$")
_SET_HDR = re.compile(r"^Hardware Set Ref:\s*(.+)$", re.I)
_PAGE = re.compile(r"^Page \d+\s*/\s*\d+$")
_DATE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
_MONEY_TOTAL = re.compile(r"^Total Price:?$", re.I)


def _lines(page) -> list[str]:
    return [l.strip() for l in page.get_text().split("\n") if l.strip()]


def parse_intec_pdf(pdf_bytes: bytes) -> dict:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = [_lines(p) for p in doc]
    doc.close()
    if not pages:
        raise ValueError("Empty PDF")

    # Lines that repeat on nearly every page are the letterhead; drop them.
    from collections import Counter
    freq = Counter(l for pg in pages for l in set(pg))
    n = len(pages)
    boiler = {l for l, c in freq.items()
              if n >= 3 and c >= max(3, int(n * 0.8)) and len(l) > 4 and not _NUM.match(l) and not _UNIT.match(l)}
    boiler |= {"Product Code", "Description", "Qty", "Price", "Unit", "Value", "Product Summary", "Door Reference"}

    def clean(pg):
        return [l for l in pg if l not in boiler and not _PAGE.match(l) and not _DATE.match(l)]

    # ── Cover page: job details ──
    cover = pages[0]
    job = {"name": "", "quote_no": "", "client": "", "rep": "", "estimator": "", "date": ""}
    for i, l in enumerate(cover):
        nxt = cover[i + 1] if i + 1 < len(cover) else ""
        if l.startswith("Re:"):
            job["name"] = l[3:].strip()
        elif l.startswith("Quote No:"):
            job["quote_no"] = (l[9:].strip() or nxt).strip()
        elif l.startswith("Rep:"):
            job["rep"] = (l[4:].strip() or nxt).strip()
        elif l.startswith("Estimator:"):
            job["estimator"] = (l[10:].strip() or nxt).strip()
        elif l.startswith("Date:"):
            job["date"] = (l[5:].strip() or nxt).strip()
    # Client: the first cover line that is not letterhead, not a label, not a value already taken
    taken = set(job.values()) | boiler
    for l in cover:
        if l in taken or ":" in l or _DATE.match(l) or _PAGE.match(l):
            continue
        job["client"] = l
        break
    if not job["name"]:
        for l in cover:
            if l.startswith("Quote Ref:"):
                job["name"] = l[10:].strip()

    # ── Product summary: codes, names, unit, price ──
    body = []
    for pg in pages:
        body += clean(pg)
    products: dict[str, dict] = {}
    order: list[str] = []
    try:
        start = next(i for i, pg in enumerate(pages) if "Product Summary" in pg)
    except StopIteration:
        start = None
    if start is not None:
        summ = []
        for pg in pages[start:]:
            summ += clean(pg)
        i = 0
        while i < len(summ):
            if _MONEY_TOTAL.match(summ[i]):
                break
            code = summ[i]
            j = i + 1
            hit = None
            while j < len(summ):
                # qty, price, unit, value      (priced)
                if _INT.match(summ[j]) and j + 3 < len(summ) and _NUM.match(summ[j + 1]) and _UNIT.match(summ[j + 2]) and _NUM.match(summ[j + 3]):
                    hit = ("p", j); break
                # qty, unit                    (unpriced)
                if _INT.match(summ[j]) and j + 1 < len(summ) and _UNIT.match(summ[j + 1]):
                    hit = ("np", j); break
                j += 1
            if hit is None:
                break
            kind, j = hit
            name = " ".join(summ[i + 1:j])
            if kind == "p":
                products[code] = {"name": name, "qty": int(summ[j]), "price": float(summ[j + 1]), "unit": summ[j + 2]}
                i = j + 4
            else:
                products[code] = {"name": name, "qty": int(summ[j]), "price": None, "unit": summ[j + 1]}
                i = j + 2
            order.append(code)
    codes = set(products)

    # ── Sets ──
    sets = []
    k = 0
    while k < len(body):
        m = _SET_HDR.match(body[k])
        if not m:
            k += 1
            continue
        code = m.group(1).strip()
        name = body[k + 1] if k + 1 < len(body) else ""
        k += 2
        items = []
        while k < len(body) and not _DOORS.match(body[k]) and not _SET_HDR.match(body[k]):
            if body[k] in codes or (k + 1 < len(body) and _looks_like_code(body[k])):
                c = body[k]
                j = k + 1
                found = None
                while j < len(body) and j < k + 12:
                    if _INT.match(body[j]) and j + 3 < len(body) and _NUM.match(body[j + 1]) and _UNIT.match(body[j + 2]) and _NUM.match(body[j + 3]):
                        found = (int(body[j]), float(body[j + 1]), j + 4); break
                    if _INT.match(body[j]) and j + 1 < len(body) and _UNIT.match(body[j + 1]):
                        found = (int(body[j]), None, j + 2); break
                    j += 1
                if found and (c in codes or found[2] - k <= 8):
                    qty, price, nxt = found
                    if c not in products:
                        products[c] = {"name": " ".join(body[k + 1:j]), "qty": 0, "price": price, "unit": body[nxt - 1] if price is None else body[nxt - 2]}
                        codes.add(c); order.append(c)
                    items.append({"code": c, "qty": qty, "price": price})
                    k = nxt
                    continue
            k += 1
        ndoors = 0
        if k < len(body) and _DOORS.match(body[k]):
            ndoors = int(_DOORS.match(body[k]).group(1)); k += 1
        refs = []
        while k < len(body) and not _SET_HDR.match(body[k]) and not _MONEY_TOTAL.match(body[k]):
            l = body[k]
            if l not in codes and _REF.match(l) and not _NUM.match(l):
                refs.append(l)
            k += 1
        if ndoors:
            refs = refs[:ndoors]          # anything after the door refs is photo captions
        sets.append({"code": code, "name": name, "items": items, "doors": ndoors or len(refs), "refs": refs})
    if not sets:
        raise ValueError("No 'Hardware Set Ref' blocks found; is this an Intec schedule?")
    return {"job": job, "products": products, "order": order, "sets": sets}


def _looks_like_code(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z0-9][A-Z0-9 ./\"'-]{1,20}", s)) and any(ch.isdigit() for ch in s) and len(s) <= 22


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def import_intec(db, data: dict, owner_id: int, create_project: bool = True, source_name: str = "") -> dict:
    """Create/refresh products and sets from parsed Intec data; optionally the job as a project."""
    from schedule import _next_set_code
    # Products: match by SKU or Intec code, case-insensitive
    existing = {}
    for p in db.query(models.Product).all():
        existing[p.sku.strip().upper()] = p
        if p.intec_code:
            existing.setdefault(p.intec_code.strip().upper(), p)
    prod_added = prod_updated = 0
    pid_by_code: dict[str, int] = {}
    for code in data["order"]:
        info = data["products"][code]
        p = existing.get(code.strip().upper())
        if p is None:
            p = models.Product(sku=code, name=info["name"] or code, category="Other", unit=info.get("unit") or "EACH",
                               sell=info.get("price"), intec_code=code, source="intec",
                               notes=f"From Intec schedule {data['job'].get('quote_no') or source_name}".strip(), active=True)
            db.add(p); db.flush(); existing[code.upper()] = p; prod_added += 1
        else:
            changed = False
            if info.get("price") is not None and p.sell is None:
                p.sell = info["price"]; changed = True
            if not p.intec_code:
                p.intec_code = code; changed = True
            if not p.active:
                p.active = True; changed = True
            prod_updated += int(changed)
        pid_by_code[code] = p.id

    # Sets: reuse a set with the same name and the same products; otherwise create
    live = db.query(models.HardwareSet).filter(models.HardwareSet.archived == False).all()   # noqa: E712
    by_name = {}
    for s in live:
        by_name.setdefault(_norm(s.name), []).append(s)
    used_codes = {s.code for s in db.query(models.HardwareSet).all()}
    sets_added = sets_reused = 0
    set_ids: dict[str, int] = {}
    for s in data["sets"]:
        want = {(pid_by_code[i["code"]], i["qty"]) for i in s["items"]}
        match = None
        for cand in by_name.get(_norm(s["name"]), []):
            have = {(it.product_id, it.qty) for it in cand.items}
            if have == want or not have:
                match = cand; break
        if match:
            if not match.items:
                for n, i in enumerate(s["items"]):
                    db.add(models.SetItem(set_id=match.id, product_id=pid_by_code[i["code"]], qty=i["qty"], sort_order=n))
            set_ids[s["code"]] = match.id; sets_reused += 1
            continue
        code = s["code"] if s["code"] not in used_codes else _next_set_code(db)
        hs = models.HardwareSet(code=code, name=s["name"], description=f"From Intec {data['job'].get('quote_no') or ''} {data['job'].get('name') or ''}".strip(),
                                fire_rated=bool(re.search(r"\bFR\b", s["name"]) and not re.search(r"\bNFR\b", s["name"])),
                                created_by_id=owner_id)
        db.add(hs); db.flush(); used_codes.add(code)
        for n, i in enumerate(s["items"]):
            db.add(models.SetItem(set_id=hs.id, product_id=pid_by_code[i["code"]], qty=i["qty"], sort_order=n))
        by_name.setdefault(_norm(s["name"]), []).append(hs)
        set_ids[s["code"]] = hs.id; sets_added += 1

    project_id, doors = None, 0
    if create_project:
        job = data["job"]
        name = job.get("name") or source_name or "Intec import"
        proj = db.query(models.Project).filter(models.Project.owner_id == owner_id, models.Project.name == name).first()
        if proj is None:
            proj = models.Project(name=name, client=job.get("client") or "", site="", description="Imported from Intec",
                                  drawing_firm="", quote_no=job.get("quote_no") or "", rep=job.get("rep") or "",
                                  kind="doors", owner_id=owner_id)
            db.add(proj); db.flush()
        have_refs = {d.ref for d in db.query(models.Door).filter(models.Door.project_id == proj.id).all()}
        for s in data["sets"]:
            for ref in s["refs"]:
                if ref in have_refs:
                    continue
                db.add(models.Door(project_id=proj.id, ref=ref, floor="", handed=False, set_id=set_ids[s["code"]],
                                   source="schedule", note=f"Intec set {s['code']}"))
                have_refs.add(ref); doors += 1
        project_id = proj.id
    db.commit()
    return {"products_added": prod_added, "products_updated": prod_updated,
            "sets_added": sets_added, "sets_reused": sets_reused,
            "project_id": project_id, "project_name": data["job"].get("name", ""), "doors": doors,
            "priced": any(v.get("price") is not None for v in data["products"].values())}
