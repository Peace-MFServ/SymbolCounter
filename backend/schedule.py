"""
Products (with the Cin7 sync), the sets library, and giving the doors on a job
their sets. Door schedules themselves are made in the CRM.
"""
import io
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

import models, auth
from datetime import datetime, timezone as _tz
from images import normalize_image
from database import get_db

router = APIRouter(prefix="/api", tags=["schedule"])

PRODUCT_IMG_DIR = Path("uploads") / "products"
PENDING_IMG_DIR = Path("uploads") / "pending_images"
PRODUCT_IMG_DIR.mkdir(parents=True, exist_ok=True)


# ── Schemas ───────────────────────────────────────────────────────────────────
class ProductOut(BaseModel):
    id: int; sku: str; name: str; category: str; unit: str
    cost: Optional[float] = None; sell: Optional[float] = None; price: Optional[float] = None
    intec_code: str = ""; product_type: str = ""; brand: str = ""
    image_url: str = ""; notes: str = ""; active: bool = True
    used_in: list[str] = []
    datasheets: int = 0; certificates: int = 0

class ProductIn(BaseModel):
    sku: str; name: str; category: str = "Other"; unit: str = "EACH"
    cost: Optional[float] = None; sell: Optional[float] = None
    intec_code: str = ""; product_type: str = ""; brand: str = ""; notes: str = ""; active: bool = True

class SetItemIn(BaseModel):
    product_id: int; qty: int = 1

class SetIn(BaseModel):
    code: str; name: str; description: str = ""; fire_rated: bool = False
    notes: str = ""; items: list[SetItemIn] = []

class SetItemOut(BaseModel):
    id: int; product_id: int; sku: str; name: str; category: str; unit: str
    qty: int; cost: Optional[float] = None; price: Optional[float] = None; line_value: Optional[float] = None
    product_type: str = ""; image_url: str = ""

class SetUse(BaseModel):
    project_id: int; project: str; doors: int; owner: str = ""

class SetOut(BaseModel):
    id: int; code: str; name: str; description: str = ""; fire_rated: bool = False
    notes: str = ""; archived: bool = False; copied_from: Optional[str] = None
    project_id: Optional[int] = None; is_standard: bool = True
    locked_by: str = ""; locked_by_me: bool = False
    product_count: int = 0; items_per_door: int = 0; cost_per_door: Optional[float] = None
    value_per_door: Optional[float] = None; priced_ok: bool = True
    used_on: list[SetUse] = []; items: list[SetItemOut] = []


# ── Helpers ───────────────────────────────────────────────────────────────────
def _img_url(p: models.Product) -> str:
    return f"/api/files/products/{Path(p.image_path).name}" if p.image_path else ""


def _used_map(db: Session) -> dict[int, list[str]]:
    """product_id -> [set codes] for every live set."""
    out: dict[int, list[str]] = {}
    rows = (db.query(models.SetItem.product_id, models.HardwareSet.code)
              .join(models.HardwareSet, models.HardwareSet.id == models.SetItem.set_id)
              .filter(models.HardwareSet.archived == False).all())   # noqa: E712
    for pid, code in rows:
        out.setdefault(pid, [])
        if code not in out[pid]:
            out[pid].append(code)
    return out


def product_price(p: models.Product) -> Optional[float]:
    """The price a schedule uses: Cin7 average cost, else the last Intec price."""
    return p.cost if p.cost else (p.sell if p.sell else None)


def job_price_fn(db: Session, pid: int):
    """Prices as this job's Cost summary has them: the sell price typed on the
    job, else the product's own, else its cost, less the job's discounts. The
    same figure the priced schedule uses, so the job page, the Door summary and
    the Cost summary always agree."""
    jps = {jp.product_id: jp for jp in db.query(models.JobPrice).filter_by(project_id=pid).all()}

    def price(p: models.Product) -> Optional[float]:
        jp = jps.get(p.id)
        cost = jp.cost if (jp and jp.cost is not None) else (p.cost or 0.0)
        sell = jp.sell if (jp and jp.sell is not None) else (p.sell if p.sell else cost)
        if jp:
            sell = sell * (1 - (jp.disc_a or 0) / 100) * (1 - (jp.disc_b or 0) / 100)
        return round(sell, 2) if sell else None
    price.sell_of = lambda p: (jps[p.id].sell if p.id in jps and jps[p.id].sell is not None
                               else (p.sell if p.sell else (jps[p.id].cost if p.id in jps and jps[p.id].cost is not None else p.cost)))
    price.discounted = lambda p: bool(p.id in jps and ((jps[p.id].disc_a or 0) or (jps[p.id].disc_b or 0)))
    return price


_TYPE_BY_CATEGORY = {
    "hinges": "01", "pivots": "01",
    "door closers": "02", "closers": "02",
    "locks": "03", "cylinders": "03", "latches": "03", "thumbturns": "03", "escutcheons": "03",
    "handles": "04", "push plates": "04", "flush pulls": "04", "pull handles": "04", "knobs": "04",
    "door signs": "05", "signs": "05", "numerals": "05", "door numerals": "05",
    "kick plates": "06", "finger plates": "06", "door protection": "06",
    "door stoppers": "07", "floor sockets": "07", "flush bolts": "07", "intumescent": "07", "hooks": "07",
    "handrails": "07", "accessories": "07",
}
_TYPE_BY_WORD = [("hinge", "01"), ("pivot", "01"), ("closer", "02"), ("cylinder", "03"), ("lock", "03"),
                 ("latch", "03"), ("thumbturn", "03"), ("escutch", "03"), ("handle", "04"), ("lever", "04"),
                 ("push plate", "04"), ("pull", "04"), ("knob", "04"), ("sign", "05"), ("numeral", "05"),
                 ("kick plate", "06"), ("finger plate", "06"), ("flush bolt", "07"), ("intumescent", "07"),
                 ("door stop", "07"), ("socket", "07"), ("hook", "07")]


def guess_product_type(category: str, name: str) -> str:
    """Intec's type number from a Cin7 category, else from the product name; blank if no idea."""
    c = (category or "").strip().lower()
    if c in _TYPE_BY_CATEGORY:
        return _TYPE_BY_CATEGORY[c]
    n = (name or "").lower()
    for word, t in _TYPE_BY_WORD:
        if word in n:
            return t
    return ""


def _product_out(p: models.Product, used: dict) -> ProductOut:
    return ProductOut(
        id=p.id, sku=p.sku, name=p.name, category=p.category or "Other", unit=p.unit or "EACH",
        cost=p.cost, sell=p.sell, price=product_price(p), intec_code=p.intec_code or "",
        product_type=p.product_type or "", brand=p.brand or "", image_url=_img_url(p),
        notes=p.notes or "", active=bool(p.active), used_in=sorted(used.get(p.id, [])),
    )


def _set_uses(db: Session, sid: int) -> list[SetUse]:
    """Projects using this set, with door counts (type assignment or per-door override)."""
    counts: dict[int, int] = {}
    names: dict[int, str] = {}
    owners: dict[int, str] = {}
    for d in db.query(models.Door).all():
        eff = d.set_id or (d.door_type.set_id if d.door_type else None)
        if eff == sid:
            counts[d.project_id] = counts.get(d.project_id, 0) + 1
    if counts:
        for p in db.query(models.Project).filter(models.Project.id.in_(list(counts))).all():
            names[p.id] = p.name
            owners[p.id] = p.owner.name if p.owner else ""
    return [SetUse(project_id=pid, project=names.get(pid, f"Project {pid}"), doors=n, owner=owners.get(pid, ""))
            for pid, n in sorted(counts.items())]


LOCK_SECONDS = 5 * 60


def _lock_holder(s: models.HardwareSet, cu) -> tuple[str, bool]:
    """(name of whoever holds a live lock, whether that is the current user)."""
    from datetime import datetime, timezone, timedelta
    if not s.locked_by_id or not s.locked_at:
        return "", False
    at = s.locked_at if s.locked_at.tzinfo else s.locked_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - at > timedelta(seconds=LOCK_SECONDS):
        return "", False
    name = s.locked_by.name if s.locked_by else "someone"
    return name, (cu is not None and s.locked_by_id == cu.id)


def _type_rank(t: str) -> int:
    return int(t) if (t or "").isdigit() else 99


def _set_out(db: Session, s: models.HardwareSet, with_uses: bool = True, cu=None, price_of=None) -> SetOut:
    items = []
    cost_total, cost_known = 0.0, True
    value_total, priced = 0.0, True
    for it in sorted(s.items, key=lambda i: (_type_rank(i.product.product_type), i.sort_order)):
        p = it.product
        price = (price_of or product_price)(p)
        items.append(SetItemOut(id=it.id, product_id=p.id, sku=p.sku, name=p.name,
                                category=p.category or "Other", unit=p.unit or "EACH",
                                qty=it.qty, cost=p.cost, price=price,
                                line_value=round(price * it.qty, 2) if price is not None else None,
                                product_type=p.product_type or "", image_url=_img_url(p)))
        if p.cost is None:
            cost_known = False
        else:
            cost_total += p.cost * it.qty
        if price is None:
            priced = False
        else:
            value_total += price * it.qty
    parent = db.query(models.HardwareSet).get(s.copied_from_id) if s.copied_from_id else None
    holder, mine = _lock_holder(s, cu)
    return SetOut(
        id=s.id, code=s.code, name=s.name, description=s.description or "",
        fire_rated=bool(s.fire_rated), notes=s.notes or "", archived=bool(s.archived),
        copied_from=f"{parent.code} {parent.name}" if parent else None,
        project_id=s.project_id, is_standard=s.project_id is None,
        locked_by=holder, locked_by_me=mine,
        product_count=len(items), items_per_door=sum(i.qty for i in items),
        cost_per_door=round(cost_total, 2) if (items and cost_known) else None,
        value_per_door=round(value_total, 2) if (items and priced) else None, priced_ok=bool(items) and priced,
        used_on=_set_uses(db, s.id) if with_uses else [], items=items,
    )


def _job_set_ids(db: Session, pid: int) -> list[int]:
    """Every set on a job: placed on it, made for it, or on one of its doors."""
    ids = [ps.set_id for ps in db.query(models.ProjectSet).filter_by(project_id=pid).order_by(models.ProjectSet.sort_order).all()]
    for (sid,) in db.query(models.HardwareSet.id).filter(models.HardwareSet.project_id == pid,
                                                         models.HardwareSet.archived == False).all():   # noqa: E712
        if sid not in ids:
            ids.append(sid)
    for d in db.query(models.Door).filter(models.Door.project_id == pid).all():
        e = _effective_set_id(d)
        if e and e not in ids:
            ids.append(e)
    return ids


def _next_set_code(db: Session, pid: Optional[int] = None) -> str:
    """The next MF number: in the library, library sets only; on a job, the
    sets on that job only, so sets made for jobs never use up library numbers."""
    best = 0
    if pid is None:
        codes = db.query(models.HardwareSet.code).filter(models.HardwareSet.project_id.is_(None)).all()
    else:
        ids = _job_set_ids(db, pid)
        codes = db.query(models.HardwareSet.code).filter(models.HardwareSet.id.in_(ids)).all() if ids else []
    for (code,) in codes:
        m = re.fullmatch(r"MF\s*(\d+)", (code or "").strip(), re.I)
        if m:
            best = max(best, int(m.group(1)))
    return f"MF {best + 1:02d}"


# ── Products ──────────────────────────────────────────────────────────────────
@router.get("/products", response_model=list[ProductOut])
def list_products(q: str = "", category: str = "", product_type: str = "", include_inactive: bool = False,
                  db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    qry = db.query(models.Product)
    if not include_inactive:
        qry = qry.filter(models.Product.active == True)   # noqa: E712
    if category:
        qry = qry.filter(models.Product.category == category)
    if product_type:
        qry = qry.filter(models.Product.product_type == ("" if product_type == "none" else product_type))
    if q:
        like = f"%{q.strip()}%"
        qry = qry.filter((models.Product.sku.ilike(like)) | (models.Product.name.ilike(like))
                         | (models.Product.intec_code.ilike(like)))
    used = _used_map(db)
    out = [_product_out(p, used) for p in qry.order_by(models.Product.sku).all()]
    # how many datasheets and certificates sit on each, in one pass
    counts: dict[tuple, int] = {}
    for pid, kind in db.query(models.ProductDocument.product_id, models.Document.kind) \
                        .join(models.Document, models.Document.id == models.ProductDocument.document_id).all():
        counts[(pid, kind)] = counts.get((pid, kind), 0) + 1
    for o in out:
        o.datasheets = counts.get((o.id, "datasheet"), 0); o.certificates = counts.get((o.id, "certificate"), 0)
    return out


@router.get("/products/categories")
def product_categories(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    rows = (db.query(models.Product.category, models.Product.id)
              .filter(models.Product.active == True).all())   # noqa: E712
    counts: dict[str, int] = {}
    for cat, _ in rows:
        counts[cat or "Other"] = counts.get(cat or "Other", 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


@router.get("/products/types")
def product_types(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Intec's product types in set order, with how many products sit under each."""
    counts: dict[str, int] = {}
    for (t,) in db.query(models.Product.product_type).filter(models.Product.active == True).all():   # noqa: E712
        counts[t or ""] = counts.get(t or "", 0) + 1
    out = [{"code": c, "name": n, "count": counts.get(c, 0)} for c, n in models.PRODUCT_TYPES]
    out.append({"code": "", "name": "Other", "count": counts.get("", 0)})
    return out


@router.post("/products/assign-types")
def assign_product_types(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Fill in a type for every product that has none, from its category or name."""
    n = 0
    for p in db.query(models.Product).filter((models.Product.product_type == "") | (models.Product.product_type.is_(None))).all():
        t = guess_product_type(p.category, p.name)
        if t:
            p.product_type = t; n += 1
    db.commit()
    return {"assigned": n}


@router.post("/products/import")
async def import_products(file: UploadFile = File(...), db: Session = Depends(get_db),
                          cu=Depends(auth.get_current_user)):
    """
    Load the Cin7 'Products Price List' export (.xlsx). Finds the header row by
    the SKU column, upserts by SKU. Existing photos, Intec codes and notes are kept.
    """
    import openpyxl
    raw = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(400, "That file is not an Excel workbook (.xlsx)")
    ws = wb.worksheets[0]
    rows = [r for r in ws.iter_rows(values_only=True)]
    hi = next((i for i, r in enumerate(rows)
               if r and any(str(c).strip().lower() == "sku" for c in r if c is not None)), None)
    if hi is None:
        raise HTTPException(400, "Could not find a SKU column. Export the Products Price List report from Cin7.")
    hdr = [str(c).strip().lower() if c is not None else "" for c in rows[hi]]
    def col(*names):
        for n in names:
            if n in hdr:
                return hdr.index(n)
        return None
    c_sku, c_name, c_unit, c_cat = col("sku"), col("product", "name"), col("unit"), col("category")
    c_cost, c_gen, c_whole = col("average cost", "averagecost", "cost"), col("general"), col("wholesale")
    if c_sku is None or c_name is None:
        raise HTTPException(400, "The export needs at least SKU and Product columns.")

    def num(v):
        try:
            f = float(v)
            return f if f > 0 else None
        except (TypeError, ValueError):
            return None

    added = updated = skipped = 0
    for r in rows[hi + 1:]:
        if not r or c_sku >= len(r) or r[c_sku] in (None, ""):
            continue
        sku = str(r[c_sku]).strip()
        name = str(r[c_name]).strip() if c_name < len(r) and r[c_name] is not None else ""
        if not sku or not name or sku.lower() in ("total", "grand total"):
            skipped += 1
            continue
        cat = (str(r[c_cat]).strip() if c_cat is not None and r[c_cat] else "Other") or "Other"
        unit = (str(r[c_unit]).strip() if c_unit is not None and r[c_unit] else "EACH") or "EACH"
        cost = num(r[c_cost]) if c_cost is not None else None
        if not cost:
            cost = None            # Cin7 shows 0 until the first delivery lands
        sell = None
        for ci in (c_whole, c_gen):
            if ci is not None and num(r[ci]):
                sell = num(r[ci]); break
        p = db.query(models.Product).filter(models.Product.sku == sku).first()
        if p:
            p.name, p.category, p.unit = name, cat, unit.upper()
            if cost is not None: p.cost = cost
            if sell is not None: p.sell = sell
            if not p.product_type: p.product_type = guess_product_type(cat, name)
            updated += 1
        else:
            db.add(models.Product(sku=sku, name=name, category=cat, unit=unit.upper(),
                                  cost=cost, sell=sell, source="cin7", product_type=guess_product_type(cat, name)))
            added += 1
    db.commit()
    return {"added": added, "updated": updated, "skipped": skipped}


# ── Cin7 straight from the API ────────────────────────────────────────────────
import cin7  # noqa: E402


def _data_dir() -> Path:
    from database import engine
    return Path(engine.url.database or ".").resolve().parent


@router.get("/cin7/status")
def cin7_status(cu=Depends(auth.get_current_user)):
    """Whether the server has a Cin7 key, and what the last sync did."""
    return {"configured": cin7.configured(), "last": cin7.last_run(_data_dir())}


@router.post("/cin7/sync")
def cin7_sync(apply: bool = False, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Dry run by default: what Cin7 has against what we hold. apply=true writes it."""
    if not cin7.configured():
        raise HTTPException(400, "No Cin7 key on this server. Add CIN7_ACCOUNT_ID and CIN7_APP_KEY to .env.")
    try:
        report = cin7.sync(db, models, guess_product_type, apply=apply)
    except cin7.Cin7Error as e:
        raise HTTPException(502, str(e))
    if apply:
        report["by"] = cu.name
        cin7.remember(_data_dir(), report)
    return report


@router.post("/cin7/pictures")
def cin7_pictures(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Pictures Cin7 holds for products that have none here, a batch per click."""
    if not cin7.configured():
        raise HTTPException(400, "No Cin7 key on this server.")
    try:
        return cin7.fetch_pictures(db, models, PRODUCT_IMG_DIR, normalize_image)
    except cin7.Cin7Error as e:
        raise HTTPException(502, str(e))


@router.post("/products", response_model=ProductOut, status_code=201)
def create_product(payload: ProductIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    sku = payload.sku.strip()
    if not sku or not payload.name.strip():
        raise HTTPException(400, "Code and name are required")
    if db.query(models.Product).filter(models.Product.sku == sku).first():
        raise HTTPException(409, f"A product with code {sku} already exists")
    p = models.Product(**{**payload.model_dump(), "sku": sku, "name": payload.name.strip(), "source": "manual"})
    db.add(p); db.commit(); db.refresh(p)
    return _product_out(p, {})


@router.put("/products/{pid}", response_model=ProductOut)
def update_product(pid: int, payload: ProductIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = db.query(models.Product).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    sku = payload.sku.strip()
    clash = db.query(models.Product).filter(models.Product.sku == sku, models.Product.id != pid).first()
    if clash:
        raise HTTPException(409, f"Another product already uses code {sku}")
    for k, v in payload.model_dump().items():
        setattr(p, k, v.strip() if isinstance(v, str) else v)
    db.commit(); db.refresh(p)
    return _product_out(p, _used_map(db))


@router.post("/products/{pid}/image", response_model=ProductOut)
async def upload_product_image(pid: int, file: UploadFile = File(...),
                               db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = db.query(models.Product).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        raise HTTPException(400, "Use a PNG, JPG, WEBP or GIF image")
    import tempfile
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        tmp.write(await file.read()); tmp_path = Path(tmp.name)
    try:
        dest = normalize_image(tmp_path, PRODUCT_IMG_DIR)
    except Exception:
        raise HTTPException(400, "That file could not be read as an image")
    finally:
        try: tmp_path.unlink()
        except OSError: pass
    if p.image_path and Path(p.image_path).exists():
        try: Path(p.image_path).unlink()
        except OSError: pass
    p.image_path = str(dest)
    db.commit(); db.refresh(p)
    return _product_out(p, _used_map(db))


def _code_keys(code: str) -> list[str]:
    """Ways a file name can spell a product code: exact, and with spaces/dots/dashes/underscores dropped."""
    c = (code or "").strip().lower()
    if not c:
        return []
    return [c, re.sub(r"[\s._\-/]+", "", c)]


@router.post("/products/import-images")
async def import_product_images(file: UploadFile = File(...), db: Session = Depends(get_db),
                                cu=Depends(auth.get_current_user)):
    """
    One zip of pictures, any folder layout. Each file is matched to a product by
    its name (without the extension) against the product code or Intec code,
    ignoring case, spaces, dots and dashes. First match wins; later files for the
    same product are reported as duplicates. Done once, the pictures show for everyone.
    """
    import zipfile, tempfile, shutil
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "Upload a .zip of the image folders")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        shutil.copyfileobj(file.file, tmp); tmp.close()
        try:
            zf = zipfile.ZipFile(tmp.name)
        except zipfile.BadZipFile:
            raise HTTPException(400, "That file is not a zip")
        lookup: dict[str, models.Product] = {}
        for prod in db.query(models.Product).all():
            for k in _code_keys(prod.sku) + _code_keys(prod.intec_code):
                lookup.setdefault(k, prod)
        exts = (".png", ".jpg", ".jpeg", ".webp", ".gif")
        matched, unmatched, dups, seen = [], [], [], set()
        PRODUCT_IMG_DIR.mkdir(parents=True, exist_ok=True)
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = Path(info.filename).name
            if name.startswith(".") or name.startswith("__MACOSX"):
                continue
            ext = Path(name).suffix.lower()
            if ext not in exts:
                continue
            stem = Path(name).stem
            prod = None
            for k in _code_keys(stem):
                if k in lookup:
                    prod = lookup[k]; break
            if not prod:
                # keep it: the Match images screen suggests a product from the words in the name
                PENDING_IMG_DIR.mkdir(parents=True, exist_ok=True)
                safe = re.sub(r"[^A-Za-z0-9._ \-()&+]+", "_", Path(info.filename).name)[-120:]
                dest = PENDING_IMG_DIR / safe
                n = 1
                while dest.exists():
                    dest = PENDING_IMG_DIR / f"{Path(safe).stem}~{n}{ext}"; n += 1
                with zf.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                unmatched.append(info.filename); continue
            if prod.id in seen:
                dups.append({"file": info.filename, "sku": prod.sku}); continue
            seen.add(prod.id)
            raw = PRODUCT_IMG_DIR / f"raw-{uuid.uuid4().hex}{ext}"
            with zf.open(info) as src, open(raw, "wb") as out:
                shutil.copyfileobj(src, out)
            try:
                dest = normalize_image(raw, PRODUCT_IMG_DIR)
            except Exception:
                raw.unlink(missing_ok=True); unmatched.append(info.filename + " (unreadable)"); seen.discard(prod.id); continue
            raw.unlink(missing_ok=True)
            if prod.image_path and Path(prod.image_path).exists():
                try: Path(prod.image_path).unlink()
                except OSError: pass
            prod.image_path = str(dest)
            matched.append({"file": info.filename, "sku": prod.sku})
        db.commit()
    finally:
        try: Path(tmp.name).unlink()
        except OSError: pass
    return {"matched": len(matched), "unmatched": sorted(unmatched), "duplicates": dups,
            "matched_files": matched}


_STOP = {"the", "a", "an", "and", "with", "for", "of", "to", "in", "on", "is", "uk", "using", "grade", "image",
         "images", "img", "photo", "pic", "pics", "download", "copy", "final", "new", "png", "jpg", "jpeg", "webp",
         "stainless", "steel", "sss", "satin", "finish", "mm", "x", "door", "doors", "product", "products"}


def _tokens(text: str) -> set[str]:
    t = re.sub(r"[-_]?\d{2,}[_-]\d+$", "", (text or "").lower())      # web suffixes like -979_40
    return {w for w in re.split(r"[^a-z0-9]+", t) if len(w) > 1 and w not in _STOP}


def _suggest_product(stem: str, products: list) -> Optional[tuple]:
    """Best product for a picture called e.g. 'ts73v', 'savoy lever' or 'thumb turn croft'."""
    flat = re.sub(r"[^a-z0-9]+", "", stem.lower())
    ftoks = _tokens(stem)
    best, best_score = None, 0.0
    for p, keys, ptoks in products:
        score = 0.0
        for k in keys:                                  # the code hidden in the file name, e.g. ts73emf
            if k and len(k) >= 4 and (k in flat or flat in k):
                score = max(score, 0.9 + min(len(k), 12) / 100)
        if ftoks and ptoks:
            hit = len(ftoks & ptoks)
            if hit:
                score = max(score, hit / len(ftoks) * 0.8 + (hit / len(ptoks)) * 0.2)
        if score > best_score:
            best, best_score = p, score
    return (best, round(best_score, 2)) if best and best_score >= 0.34 else None


def _product_index(db: Session) -> list:
    out = []
    for p in db.query(models.Product).filter(models.Product.active == True).all():   # noqa: E712
        keys = [k for k in (_code_keys(p.sku)[1:2] + _code_keys(p.intec_code)[1:2]) if k]
        out.append((p, keys, _tokens(f"{p.sku} {p.name} {p.brand or ''}")))
    return out


def _pending_out(f: Path, idx) -> dict:
    sug = _suggest_product(f.stem, idx)
    return {"file": f.name, "url": f"/api/files/pending/{f.name}",
            "suggestion": {"product_id": sug[0].id, "sku": sug[0].sku, "name": sug[0].name,
                           "has_image": bool(sug[0].image_path), "score": sug[1]} if sug else None}


@router.get("/products/pending-images")
def list_pending_images(offset: int = 0, limit: int = 0, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Pictures from the zip that no code matched, each with the app's best guess.
    With limit, returns {"total", "items"} for one page; without, the whole list (older callers)."""
    files = sorted((f for f in PENDING_IMG_DIR.iterdir() if f.is_file()), key=lambda f: f.name.lower()) if PENDING_IMG_DIR.exists() else []
    if limit <= 0:
        idx = _product_index(db) if files else []
        return [_pending_out(f, idx) for f in files]
    page = files[offset:offset + limit]
    idx = _product_index(db) if page else []
    strong = 0
    if page:
        for f in files:
            sug = _suggest_product(f.stem, idx)
            if sug and sug[1] >= 0.9 and not sug[0].image_path:
                strong += 1
    return {"total": len(files), "strong": strong, "items": [_pending_out(f, idx) for f in page]}


@router.get("/files/pending/{filename}")
def serve_pending_image(filename: str, cu=Depends(auth.get_current_user)):
    path = PENDING_IMG_DIR / Path(filename).name
    if not path.exists():
        raise HTTPException(404, "Image not found")
    return FileResponse(str(path))


class AssignIn(BaseModel):
    product_id: int


def _attach_pending(db: Session, fname: str, product_id: int) -> models.Product:
    src = PENDING_IMG_DIR / Path(fname).name
    if not src.exists():
        raise HTTPException(404, "That picture is no longer waiting")
    p = db.query(models.Product).get(product_id)
    if not p:
        raise HTTPException(404, "Product not found")
    try:
        dest = normalize_image(src, PRODUCT_IMG_DIR)
    except Exception:
        raise HTTPException(400, "That picture could not be read")
    src.unlink(missing_ok=True)
    if p.image_path and Path(p.image_path).exists():
        try: Path(p.image_path).unlink()
        except OSError: pass
    p.image_path = str(dest)
    return p


@router.post("/products/pending-images/{fname}/assign")
def assign_pending_image(fname: str, payload: AssignIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = _attach_pending(db, fname, payload.product_id); db.commit()
    return {"ok": True, "sku": p.sku}


class NewFromPictureIn(BaseModel):
    sku: str = ""; name: str; product_type: str = ""; category: str = "Other"


@router.post("/products/pending-images/{fname}/create", response_model=ProductOut, status_code=201)
def create_product_from_picture(fname: str, payload: NewFromPictureIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The estimator knows what the picture is: make the product and put the picture on it in one go."""
    sku, name = payload.sku.strip(), payload.name.strip()
    if not name:
        raise HTTPException(400, "Give it a name")
    if sku:
        if db.query(models.Product).filter(func.lower(models.Product.sku) == sku.lower()).first():
            raise HTTPException(409, f"{sku} already exists. Use the search to put the picture on it instead.")
    else:
        # no code given: make one from the name, e.g. "Gold lever handle" -> GOLD-LEVER-HANDLE, GOLD-LEVER-HANDLE-2 ...
        base = re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-")[:40] or "ITEM"
        sku, n = base, 2
        while db.query(models.Product).filter(func.lower(models.Product.sku) == sku.lower()).first():
            sku = f"{base}-{n}"; n += 1
    p = models.Product(sku=sku, name=name, category=payload.category or "Other", unit="EACH",
                       product_type=payload.product_type or guess_product_type(payload.category or "", name),
                       source="manual", active=True)
    db.add(p); db.flush()
    _attach_pending(db, fname, p.id)
    db.commit(); db.refresh(p)
    return _product_out(p, _used_map(db))


@router.delete("/products/pending-images/{fname}", status_code=204)
def skip_pending_image(fname: str, cu=Depends(auth.get_current_user)):
    path = PENDING_IMG_DIR / Path(fname).name
    if path.exists():
        path.unlink()


class AcceptIn(BaseModel):
    min_score: float = 0.9


@router.post("/products/pending-images/accept-suggestions")
def accept_suggestions(payload: AcceptIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Take every confident guess in one go (products that already have a picture are left alone)."""
    if not PENDING_IMG_DIR.exists():
        return {"accepted": 0}
    idx = _product_index(db)
    done, taken = 0, set()
    for f in sorted(PENDING_IMG_DIR.iterdir()):
        if not f.is_file():
            continue
        sug = _suggest_product(f.stem, idx)
        if not sug or sug[1] < payload.min_score or sug[0].image_path or sug[0].id in taken:
            continue
        _attach_pending(db, f.name, sug[0].id); taken.add(sug[0].id); done += 1
    db.commit()
    return {"accepted": done}


@router.post("/products/pending-images/apply-map")
async def apply_image_map(file: UploadFile = File(...), db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """
    A CSV of 'file name,product code' (one per line, header optional) that places
    waiting pictures on products. Lines whose file or product is not found are reported.
    """
    import csv
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    placed, missing_file, missing_product, taken = 0, [], [], set()
    lookup: dict[str, models.Product] = {}
    for prod in db.query(models.Product).all():
        for k in _code_keys(prod.sku) + _code_keys(prod.intec_code):
            lookup.setdefault(k, prod)
    # match by full name, or by the name without extension and any ~1 copy suffix
    def stem_key(name: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", re.sub(r"~\d+$", "", Path(name).stem).lower())
    by_name, by_stem = {}, {}
    if PENDING_IMG_DIR.exists():
        for f in PENDING_IMG_DIR.iterdir():
            if f.is_file():
                by_name[f.name.lower()] = f.name; by_stem.setdefault(stem_key(f.name), f.name)
    used_files: set[str] = set()
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2:
            continue
        fname, code = row[0].strip(), row[1].strip()
        if not fname or not code or fname.lower() in ("file", "filename", "image"):
            continue
        real = by_name.get(fname.lower()) or by_stem.get(stem_key(fname))
        if not real:
            missing_file.append(fname); continue
        prod = next((lookup[k] for k in _code_keys(code) if k in lookup), None)
        if not prod:
            missing_product.append(f"{fname} -> {code}"); continue
        if prod.id in taken:
            continue
        # one picture can serve several products (finish variants): copy, delete the pending file at the end
        src = PENDING_IMG_DIR / real
        try:
            dest = normalize_image(src, PRODUCT_IMG_DIR)
        except Exception:
            missing_file.append(fname + " (unreadable)"); continue
        if prod.image_path and Path(prod.image_path).exists():
            try: Path(prod.image_path).unlink()
            except OSError: pass
        prod.image_path = str(dest); taken.add(prod.id); used_files.add(real); placed += 1
    db.commit()
    for real in used_files:
        try: (PENDING_IMG_DIR / real).unlink()
        except OSError: pass
    return {"placed": placed, "missing_file": sorted(set(missing_file)), "missing_product": missing_product}


@router.delete("/products/{pid}", status_code=204)
def archive_product(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = db.query(models.Product).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    p.active = False
    db.commit()


@router.get("/files/products/{filename}")
def serve_product_image(filename: str, cu=Depends(auth.get_current_user)):
    path = PRODUCT_IMG_DIR / Path(filename).name
    if not path.exists():
        raise HTTPException(404, "Image not found")
    return FileResponse(str(path))


# ── Hardware sets ─────────────────────────────────────────────────────────────
@router.get("/sets", response_model=list[SetOut])
def list_sets(include_archived: bool = False, project_id: Optional[int] = None,
              db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The standard library, plus (when project_id is given) that job's own copies."""
    qry = db.query(models.HardwareSet)
    if not include_archived:
        qry = qry.filter(models.HardwareSet.archived == False)   # noqa: E712
    if project_id is None:
        qry = qry.filter(models.HardwareSet.project_id.is_(None))
    else:
        qry = qry.filter((models.HardwareSet.project_id.is_(None)) | (models.HardwareSet.project_id == project_id))
    return [_set_out(db, s, cu=cu) for s in qry.order_by(models.HardwareSet.code).all()]


@router.get("/sets/next-code")
def next_set_code(project_id: Optional[int] = None, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    return {"code": _next_set_code(db, project_id)}


@router.post("/projects/{pid}/sets", response_model=SetOut, status_code=201)
def create_job_set(pid: int, payload: SetIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A set made on a job belongs to that job: it is not added to the set library."""
    _edit_project(pid, db, cu)
    if not payload.name.strip():
        raise HTTPException(400, "A set needs a name")
    code = payload.code.strip() or _next_set_code(db, pid)
    ids = _job_set_ids(db, pid)
    if ids and db.query(models.HardwareSet).filter(models.HardwareSet.id.in_(ids), models.HardwareSet.code == code).first():
        raise HTTPException(409, f"This job already has a set {code}")
    s = models.HardwareSet(code=code, name=payload.name.strip(), description=payload.description,
                           fire_rated=payload.fire_rated, notes=payload.notes, created_by_id=cu.id, project_id=pid)
    db.add(s); db.flush()
    _apply_items(db, s, payload.items)
    _link_set(db, pid, s.id)
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu, price_of=job_price_fn(db, pid))


@router.post("/sets/{sid}/to-library", response_model=SetOut)
def save_set_to_library(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A job's set worth keeping: a copy goes into the library under the next
    library number. The job keeps its own set as it is."""
    src = _set_or_404(sid, db)
    if src.project_id is None:
        raise HTTPException(400, "That set is already in the library")
    s = models.HardwareSet(code=_next_set_code(db), name=src.name, description=src.description,
                           fire_rated=src.fire_rated, notes=src.notes, created_by_id=cu.id)
    db.add(s); db.flush()
    for i, it in enumerate(src.items):
        s.items.append(models.SetItem(product_id=it.product_id, qty=it.qty, sort_order=i))
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu)


@router.get("/sets/{sid}", response_model=SetOut)
def get_set(sid: int, project_id: Optional[int] = None, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """With project_id, prices are that job's (its Cost summary)."""
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    return _set_out(db, s, cu=cu, price_of=job_price_fn(db, project_id) if project_id else None)


@router.get("/projects/{pid}/prices")
def job_prices(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Every product's price on this job, as {product_id: price}."""
    _own_project(pid, db, cu)
    pf = job_price_fn(db, pid)
    return {p.id: pf(p) for p in db.query(models.Product).filter(models.Product.active == True).all()}   # noqa: E712


def _apply_items(db: Session, s: models.HardwareSet, items: list[SetItemIn]):
    seen = set()
    s.items.clear()
    db.flush()
    for i, it in enumerate(items):
        if it.product_id in seen or it.qty <= 0:
            continue
        if not db.query(models.Product).get(it.product_id):
            raise HTTPException(400, f"Product {it.product_id} does not exist")
        seen.add(it.product_id)
        s.items.append(models.SetItem(product_id=it.product_id, qty=it.qty, sort_order=i))


@router.post("/sets", response_model=SetOut, status_code=201)
def create_set(payload: SetIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    code = payload.code.strip() or _next_set_code(db)
    if not payload.name.strip():
        raise HTTPException(400, "A set needs a name")
    if db.query(models.HardwareSet).filter(models.HardwareSet.code == code, models.HardwareSet.project_id.is_(None),
                                           models.HardwareSet.archived == False).first():   # noqa: E712
        raise HTTPException(409, f"Set {code} already exists")
    s = models.HardwareSet(code=code, name=payload.name.strip(), description=payload.description,
                           fire_rated=payload.fire_rated, notes=payload.notes, created_by_id=cu.id)
    db.add(s); db.flush()
    _apply_items(db, s, payload.items)
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu)


@router.put("/sets/{sid}", response_model=SetOut)
def update_set(sid: int, payload: SetIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    if s.project_id:
        _edit_project(s.project_id, db, cu)
    holder, mine = _lock_holder(s, cu)
    if holder and not mine:
        raise HTTPException(423, f"{holder} is editing this set")
    code = payload.code.strip() or s.code
    clash = db.query(models.HardwareSet).filter(models.HardwareSet.code == code, models.HardwareSet.id != sid,
                                                models.HardwareSet.project_id.is_(s.project_id) if s.project_id is None
                                                else models.HardwareSet.project_id == s.project_id,
                                                models.HardwareSet.archived == False).first()   # noqa: E712
    if clash:
        raise HTTPException(409, f"Another set already uses code {code}")
    s.code, s.name = code, payload.name.strip() or s.name
    s.description, s.fire_rated, s.notes = payload.description, payload.fire_rated, payload.notes
    _apply_items(db, s, payload.items)
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu)


@router.post("/sets/{sid}/copy", response_model=SetOut, status_code=201)
def copy_set(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    src = db.query(models.HardwareSet).get(sid)
    if not src:
        raise HTTPException(404, "Set not found")
    s = models.HardwareSet(code=_next_set_code(db), name=f"{src.name} (copy)", description=src.description,
                           fire_rated=src.fire_rated, notes=src.notes, copied_from_id=src.id, created_by_id=cu.id)
    db.add(s); db.flush()
    for i, it in enumerate(src.items):
        s.items.append(models.SetItem(product_id=it.product_id, qty=it.qty, sort_order=i))
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu)


@router.delete("/sets/{sid}", status_code=204)
def archive_set(sid: int, force: bool = False, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Delete a set. If it is on jobs, force=true takes it off them and leaves those doors without a set."""
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    if s.project_id:
        _edit_project(s.project_id, db, cu)
    uses = _set_uses(db, sid)
    if uses and not force:
        raise HTTPException(409, "This set is on " + ", ".join(u.project for u in uses) + ".")
    if uses:
        for d in db.query(models.Door).filter(models.Door.set_id == sid).all():
            d.set_id = None
        for t in db.query(models.DoorType).filter(models.DoorType.set_id == sid).all():
            t.set_id = None; t.status = "decide"
        db.query(models.ProjectSet).filter(models.ProjectSet.set_id == sid).delete(synchronize_session=False)
    s.archived = True
    db.commit()


# ═════════════════════════════════════════════════════════════════════════════
# Doors
# ═════════════════════════════════════════════════════════════════════════════

# ═════════════════════════════════════════════════════════════════════════════
# Sets on the doors of a job
# ═════════════════════════════════════════════════════════════════════════════
def _own_project(pid: int, db: Session, cu) -> models.Project:
    from jobs import own_project
    return own_project(pid, db, cu)


def _edit_project(pid: int, db: Session, cu) -> models.Project:
    from jobs import edit_project
    return edit_project(pid, db, cu)


def _usable_set(db: Session, pid: int, sid: int) -> models.HardwareSet:
    """A library set, or this job's own: never another job's set."""
    x = db.query(models.HardwareSet).get(sid)
    if not x or (x.project_id is not None and x.project_id != pid):
        raise HTTPException(404, "Set not found")
    return x


class AssignSetIn(BaseModel):
    door_ids: list[int] = []
    set_id: Optional[int] = None


@router.post("/projects/{pid}/doors/assign-set")
def assign_set_to_doors(pid: int, payload: AssignSetIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Many doors given one set at once (or none). A library set joins the job."""
    _edit_project(pid, db, cu)
    if payload.set_id:
        _usable_set(db, pid, payload.set_id)
    ids = set(payload.door_ids[:5000])
    doors = db.query(models.Door).filter(models.Door.project_id == pid, models.Door.id.in_(ids)).all() if ids else []
    for d in doors:
        d.set_id = payload.set_id
    if payload.set_id and doors:
        _link_set(db, pid, payload.set_id)
    db.commit()
    return {"doors": len(doors)}



class JobSetOut(BaseModel):
    set: SetOut; doors: int; door_refs: list[str] = []; value: Optional[float] = None
    from_types: int = 0

class JobOut(BaseModel):
    project_id: int; name: str; quote_no: str = ""; client: str = ""; site: str = ""; rep: str = ""; kind: str = ""
    sets: list[JobSetOut] = []; library: list[SetOut] = []
    doors_total: int = 0; doors_no_set: int = 0; types_to_decide: int = 0; plans: int = 0
    items: int = 0; value: Optional[float] = None; priced_ok: bool = False
    checks: list[dict] = []
    owner_id: Optional[int] = None; owner_name: str = ""
    revision: int = 1; sets_only: bool = False


def _set_or_404(sid: int, db: Session) -> models.HardwareSet:
    s = db.query(models.HardwareSet).get(sid)
    if not s or s.archived:
        raise HTTPException(404, "Set not found")
    return s


def _effective_set_id(d: models.Door) -> Optional[int]:
    if d.set_id:
        return d.set_id
    t = d.door_type
    if t and t.status != "excluded":
        return t.set_id
    return None


def _link_set(db: Session, pid: int, sid: int):
    if not db.query(models.ProjectSet).filter_by(project_id=pid, set_id=sid).first():
        n = db.query(models.ProjectSet).filter_by(project_id=pid).count()
        db.add(models.ProjectSet(project_id=pid, set_id=sid, sort_order=n))


def _ref_key(ref: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", ref or "")]



# ── The job, in one call ──────────────────────────────────────────────────────
@router.get("/projects/{pid}/job", response_model=JobOut)
def get_job(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = _own_project(pid, db, cu)
    pf = job_price_fn(db, pid)
    doors = db.query(models.Door).filter(models.Door.project_id == pid).all()
    by_set: dict[int, list] = {}
    no_set = 0
    for d in doors:
        eff = _effective_set_id(d)
        if eff:
            by_set.setdefault(eff, []).append(d)
        elif not (d.door_type and d.door_type.status == "excluded"):
            no_set += 1
    linked = [ps.set_id for ps in db.query(models.ProjectSet).filter_by(project_id=pid).order_by(models.ProjectSet.sort_order).all()]
    order = linked + [sid for sid in by_set if sid not in linked]
    sets_out, items_total, value_total, priced = [], 0, 0.0, True
    types = db.query(models.DoorType).filter(models.DoorType.project_id == pid).all()
    types_by_set: dict[int, int] = {}
    for t in types:
        if t.set_id and t.status != "excluded":
            types_by_set[t.set_id] = types_by_set.get(t.set_id, 0) + 1
    for sid in order:
        s = db.query(models.HardwareSet).get(sid)
        if not s or s.archived:
            continue
        so = _set_out(db, s, with_uses=False, cu=cu, price_of=pf)
        ds = sorted(by_set.get(sid, []), key=lambda d: _ref_key(d.ref))
        n = len(ds)
        items_total += so.items_per_door * n
        if so.value_per_door is None:
            if n: priced = False
            val = None
        else:
            val = round(so.value_per_door * n, 2); value_total += val
        sets_out.append(JobSetOut(set=so, doors=n, door_refs=[d.ref + ("h" if d.handed else "") for d in ds],
                                  value=val, from_types=types_by_set.get(sid, 0)))
    on_job = {js.set.id for js in sets_out}
    library = [_set_out(db, s, with_uses=False, cu=cu)
               for s in db.query(models.HardwareSet).filter(models.HardwareSet.archived == False,   # noqa: E712
                                                            models.HardwareSet.project_id.is_(None)).order_by(models.HardwareSet.code).all()
               if s.id not in on_job]
    decide = sum(1 for t in types if t.status == "decide")
    checks = []
    if decide:
        checks.append({"level": "warn", "text": f"{decide} door type{'s' if decide != 1 else ''} from the plans still to decide"})
    if no_set:
        checks.append({"level": "warn", "text": f"{no_set} door{'s' if no_set != 1 else ''} without a set"})
    empty = [js.set.code for js in sets_out if js.doors == 0]
    if empty:
        checks.append({"level": "info", "text": ("Sets with no quantity yet: " if p.sets_only else "Sets with no doors yet: ")
                       + ", ".join(empty) + ". They are left off the schedule."})
    unpriced = [js.set.code for js in sets_out if js.doors and not js.set.priced_ok]
    if unpriced:
        checks.append({"level": "info", "text": "No price yet on every product in: " + ", ".join(unpriced)})
    if not p.quote_no:
        checks.append({"level": "info", "text": "No quote number on the job"})
    if sets_out and not checks:
        checks.append({"level": "ok", "text": "Every set has a quantity and a price" if p.sets_only else "Every door has a set and every set is priced"})
    return JobOut(project_id=pid, name=p.name, quote_no=p.quote_no or "", client=p.client or "", site=p.site or "",
                  rep=p.rep or "", kind=p.kind or "symbols", sets=sets_out, library=library,
                  doors_total=len(doors), doors_no_set=no_set, types_to_decide=decide,
                  plans=len(p.drawings), items=items_total,
                  value=round(value_total, 2) if (sets_out and priced) else None, priced_ok=bool(sets_out) and priced,
                  checks=checks, owner_id=p.owner_id, owner_name=p.owner.name if p.owner else "",
                  revision=p.revision or 1, sets_only=bool(p.sets_only))


# ── Costs pasted from Intec, onto the products ───────────────────────────────
class CostPasteIn(BaseModel):
    text: str = ""; update_cost: bool = False


def parse_intec_cost_rows(text: str) -> list[dict]:
    """
    Rows copied out of Intec's Cost Summary grid: tab-separated
    code, description, qty, cost, markup, sell, disc A, disc B, actual, line value, margin.
    Descriptions can contain line breaks, so lines are joined until a row has enough columns.
    """
    def num(v):
        try:
            return float(str(v).replace(",", "").strip())
        except ValueError:
            return None
    rows, buf = [], ""
    for line in text.splitlines():
        buf = (buf + "\n" + line) if buf else line
        parts = buf.split("\t")
        if parts and parts[0].strip() == "":
            parts = parts[1:]
        if len(parts) >= 11 and num(parts[-1]) is not None and num(parts[-9]) is not None:
            code = parts[0].strip()
            desc = " ".join(" ".join(parts[1:-9]).split())
            qty, cost, markup, sell = num(parts[-9]), num(parts[-8]), num(parts[-7]), num(parts[-6])
            if code and sell is not None:
                rows.append({"sku": code, "name": desc, "qty": qty or 0.0, "cost": cost or 0.0, "sell": sell})
            buf = ""
    return rows


@router.post("/products/import-intec-costs")
def import_intec_costs(payload: CostPasteIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """
    Takes the rows pasted from an Intec Cost Summary and puts the sell prices on the
    product file. Products are matched by code (or Intec code); missing ones are created.
    Cin7 stays the source of cost: Intec's cost is only used where a product has none,
    unless update_cost is set.
    """
    rows = parse_intec_cost_rows(payload.text)
    if not rows:
        raise HTTPException(400, "No rows found. Copy the lines from Intec's Cost Summary grid and paste them in.")
    added = updated = 0
    for r in rows:
        key = r["sku"].lower()
        p = (db.query(models.Product).filter(func.lower(models.Product.sku) == key).first()
             or db.query(models.Product).filter(func.lower(models.Product.intec_code) == key).first())
        if not p:
            p = models.Product(sku=r["sku"], name=r["name"] or r["sku"], category="Other", unit="EACH",
                               intec_code=r["sku"], product_type=guess_product_type("", r["name"]), source="intec", active=True)
            db.add(p); added += 1
        else:
            updated += 1
        p.sell = r["sell"] if r["sell"] > 0 else p.sell
        if r["cost"] > 0 and (payload.update_cost or not p.cost):
            p.cost = r["cost"]
        if not p.intec_code:
            p.intec_code = r["sku"]
    db.commit()
    return {"rows": len(rows), "added": added, "updated": updated}


# ── Cost summary: Intec's cost / markup / sell / discount / margin table ──────


# ── Locks: one person edits a set at a time ───────────────────────────────────
@router.post("/sets/{sid}/lock")
def lock_set(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = _set_or_404(sid, db)
    if s.project_id:
        _edit_project(s.project_id, db, cu)
    holder, mine = _lock_holder(s, cu)
    if holder and not mine:
        raise HTTPException(423, f"{holder} is editing this set")
    s.locked_by_id = cu.id; s.locked_at = datetime.now(_tz.utc); db.commit()
    return {"locked": True, "expires_in": LOCK_SECONDS}


@router.delete("/sets/{sid}/lock")
def unlock_set(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = _set_or_404(sid, db)
    if s.locked_by_id == cu.id:
        s.locked_by_id = None; s.locked_at = None; db.commit()
    return {"locked": False}


# ── Copies ────────────────────────────────────────────────────────────────────
def _copy_for_job(db: Session, pid: int, src: models.HardwareSet, cu) -> models.HardwareSet:
    """This job's own copy of a library set, with the job's doors, door types and
    place in the job's list moved onto it. The library set is left as it was."""
    s = models.HardwareSet(code=src.code, name=src.name, description=src.description, fire_rated=src.fire_rated,
                           notes=src.notes, copied_from_id=src.id, created_by_id=cu.id, project_id=pid)
    db.add(s); db.flush()
    for i, it in enumerate(src.items):
        s.items.append(models.SetItem(product_id=it.product_id, qty=it.qty, sort_order=i))
    for d in db.query(models.Door).filter(models.Door.project_id == pid).all():
        if _effective_set_id(d) == src.id:
            d.set_id = s.id
    for t in db.query(models.DoorType).filter(models.DoorType.project_id == pid, models.DoorType.set_id == src.id).all():
        t.set_id = s.id
    link = db.query(models.ProjectSet).filter_by(project_id=pid, set_id=src.id).first()
    if link:
        link.set_id = s.id
    else:
        _link_set(db, pid, s.id)
    db.flush()
    return s


@router.post("/projects/{pid}/sets/{sid}/copy-for-job", response_model=SetOut, status_code=201)
def copy_set_for_job(pid: int, sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """
    A job wants a different hinge but the standard set must not change:
    copy the set for this job only and move the job's doors onto the copy.
    """
    _edit_project(pid, db, cu); src = _set_or_404(sid, db)
    if src.project_id == pid:
        return _set_out(db, src, cu=cu)
    s = _copy_for_job(db, pid, src, cu)
    db.commit(); db.refresh(s)
    return _set_out(db, s, cu=cu)



# ── Standard sets from a file (Evan's library) ────────────────────────────────
@router.post("/sets/import-json")
async def import_sets_json(file: UploadFile = File(...), db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """
    A JSON file of standard sets: {"sets":[{"code","name","items":[[sku, qty, price, type], …]}],
    "product_names":{sku: name}}. Missing products are created; existing sets with the
    same code are refreshed.
    """
    import json
    try:
        data = json.loads((await file.read()).decode("utf-8"))
    except Exception:
        raise HTTPException(400, "Not a readable JSON file")
    names = data.get("product_names", {})
    by_sku = {p.sku.strip().upper(): p for p in db.query(models.Product).all()}
    for p in list(by_sku.values()):
        if p.intec_code:
            by_sku.setdefault(p.intec_code.strip().upper(), p)
    prod_added = sets_added = sets_updated = 0
    for s in data.get("sets", []):
        code, name = (s.get("code") or "").strip(), (s.get("name") or "").strip()
        if not code or not name:
            continue
        items_in = []
        for row in s.get("items", []):
            sku, qty, price, ptype = (list(row) + ["", 1, None, ""])[:4]
            key = str(sku).strip().upper()
            p = by_sku.get(key)
            if p is None:
                pname = names.get(sku, str(sku))
                p = models.Product(sku=str(sku).strip(), name=pname, category="Other", unit="EACH",
                                   sell=price, product_type=ptype or guess_product_type("Other", pname),
                                   intec_code=str(sku).strip(), source="intec",
                                   notes="From the standard set library", active=True)
                db.add(p); db.flush(); by_sku[key] = p; prod_added += 1
            else:
                if price and p.sell is None: p.sell = price
                if ptype and not p.product_type: p.product_type = ptype
            items_in.append(SetItemIn(product_id=p.id, qty=int(qty or 1)))
        hs = db.query(models.HardwareSet).filter(models.HardwareSet.code == code, models.HardwareSet.project_id.is_(None),
                                                 models.HardwareSet.archived == False).first()   # noqa: E712
        if hs:
            hs.name = name; sets_updated += 1
        else:
            hs = models.HardwareSet(code=code, name=name, description=s.get("description", ""),
                                    fire_rated=bool(re.search(r"\bFR\b", name) and not re.search(r"\bNFR\b", name)),
                                    created_by_id=cu.id)
            db.add(hs); db.flush(); sets_added += 1
        _apply_items(db, hs, items_in)
    db.commit()
    return {"products_added": prod_added, "sets_added": sets_added, "sets_updated": sets_updated}


