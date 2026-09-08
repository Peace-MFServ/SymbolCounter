"""
Ironmongery scheduling: products, hardware sets, door types, doors, and the
schedule output. Kept out of main.py so the counting app and the scheduling
app can grow without tangling.
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

import models, auth
from database import get_db

router = APIRouter(prefix="/api", tags=["schedule"])

PRODUCT_IMG_DIR = Path("uploads") / "products"
PRODUCT_IMG_DIR.mkdir(parents=True, exist_ok=True)


# ── Schemas ───────────────────────────────────────────────────────────────────
class ProductOut(BaseModel):
    id: int; sku: str; name: str; category: str; unit: str
    cost: Optional[float] = None; sell: Optional[float] = None
    intec_code: str = ""; image_url: str = ""; notes: str = ""; active: bool = True
    used_in: list[str] = []

class ProductIn(BaseModel):
    sku: str; name: str; category: str = "Other"; unit: str = "EACH"
    cost: Optional[float] = None; sell: Optional[float] = None
    intec_code: str = ""; notes: str = ""; active: bool = True

class SetItemIn(BaseModel):
    product_id: int; qty: int = 1

class SetIn(BaseModel):
    code: str; name: str; description: str = ""; fire_rated: bool = False
    notes: str = ""; items: list[SetItemIn] = []

class SetItemOut(BaseModel):
    id: int; product_id: int; sku: str; name: str; category: str; unit: str
    qty: int; cost: Optional[float] = None; image_url: str = ""

class SetUse(BaseModel):
    project_id: int; project: str; doors: int

class SetOut(BaseModel):
    id: int; code: str; name: str; description: str = ""; fire_rated: bool = False
    notes: str = ""; archived: bool = False; copied_from: Optional[str] = None
    product_count: int = 0; items_per_door: int = 0; cost_per_door: Optional[float] = None
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


def _product_out(p: models.Product, used: dict) -> ProductOut:
    return ProductOut(
        id=p.id, sku=p.sku, name=p.name, category=p.category or "Other", unit=p.unit or "EACH",
        cost=p.cost, sell=p.sell, intec_code=p.intec_code or "", image_url=_img_url(p),
        notes=p.notes or "", active=bool(p.active), used_in=sorted(used.get(p.id, [])),
    )


def _set_uses(db: Session, sid: int) -> list[SetUse]:
    """Projects using this set, with door counts (type assignment or per-door override)."""
    counts: dict[int, int] = {}
    names: dict[int, str] = {}
    for d in db.query(models.Door).all():
        eff = d.set_id or (d.door_type.set_id if d.door_type else None)
        if eff == sid:
            counts[d.project_id] = counts.get(d.project_id, 0) + 1
    if counts:
        for p in db.query(models.Project).filter(models.Project.id.in_(list(counts))).all():
            names[p.id] = p.name
    return [SetUse(project_id=pid, project=names.get(pid, f"Project {pid}"), doors=n)
            for pid, n in sorted(counts.items())]


def _set_out(db: Session, s: models.HardwareSet, with_uses: bool = True) -> SetOut:
    items = []
    cost_total, cost_known = 0.0, True
    for it in s.items:
        p = it.product
        items.append(SetItemOut(id=it.id, product_id=p.id, sku=p.sku, name=p.name,
                                category=p.category or "Other", unit=p.unit or "EACH",
                                qty=it.qty, cost=p.cost, image_url=_img_url(p)))
        if p.cost is None:
            cost_known = False
        else:
            cost_total += p.cost * it.qty
    parent = db.query(models.HardwareSet).get(s.copied_from_id) if s.copied_from_id else None
    return SetOut(
        id=s.id, code=s.code, name=s.name, description=s.description or "",
        fire_rated=bool(s.fire_rated), notes=s.notes or "", archived=bool(s.archived),
        copied_from=f"{parent.code} {parent.name}" if parent else None,
        product_count=len(items), items_per_door=sum(i.qty for i in items),
        cost_per_door=round(cost_total, 2) if (items and cost_known) else None,
        used_on=_set_uses(db, s.id) if with_uses else [], items=items,
    )


def _next_set_code(db: Session) -> str:
    best = 0
    for (code,) in db.query(models.HardwareSet.code).all():
        m = re.fullmatch(r"MF\s*(\d+)", (code or "").strip(), re.I)
        if m:
            best = max(best, int(m.group(1)))
    return f"MF {best + 1:02d}"


# ── Products ──────────────────────────────────────────────────────────────────
@router.get("/products", response_model=list[ProductOut])
def list_products(q: str = "", category: str = "", include_inactive: bool = False,
                  db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    qry = db.query(models.Product)
    if not include_inactive:
        qry = qry.filter(models.Product.active == True)   # noqa: E712
    if category:
        qry = qry.filter(models.Product.category == category)
    if q:
        like = f"%{q.strip()}%"
        qry = qry.filter((models.Product.sku.ilike(like)) | (models.Product.name.ilike(like))
                         | (models.Product.intec_code.ilike(like)))
    used = _used_map(db)
    return [_product_out(p, used) for p in qry.order_by(models.Product.sku).all()]


@router.get("/products/categories")
def product_categories(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    rows = (db.query(models.Product.category, models.Product.id)
              .filter(models.Product.active == True).all())   # noqa: E712
    counts: dict[str, int] = {}
    for cat, _ in rows:
        counts[cat or "Other"] = counts.get(cat or "Other", 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


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
        sell = None
        for ci in (c_whole, c_gen):
            if ci is not None and num(r[ci]):
                sell = num(r[ci]); break
        p = db.query(models.Product).filter(models.Product.sku == sku).first()
        if p:
            p.name, p.category, p.unit = name, cat, unit.upper()
            if cost is not None: p.cost = cost
            if sell is not None: p.sell = sell
            updated += 1
        else:
            db.add(models.Product(sku=sku, name=name, category=cat, unit=unit.upper(),
                                  cost=cost, sell=sell, source="cin7"))
            added += 1
    db.commit()
    return {"added": added, "updated": updated, "skipped": skipped}


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
    dest = PRODUCT_IMG_DIR / f"{uuid.uuid4().hex}{ext}"
    dest.write_bytes(await file.read())
    if p.image_path and Path(p.image_path).exists():
        try: Path(p.image_path).unlink()
        except OSError: pass
    p.image_path = str(dest)
    db.commit(); db.refresh(p)
    return _product_out(p, _used_map(db))


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
def list_sets(include_archived: bool = False, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    qry = db.query(models.HardwareSet)
    if not include_archived:
        qry = qry.filter(models.HardwareSet.archived == False)   # noqa: E712
    return [_set_out(db, s) for s in qry.order_by(models.HardwareSet.code).all()]


@router.get("/sets/next-code")
def next_set_code(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    return {"code": _next_set_code(db)}


@router.get("/sets/{sid}", response_model=SetOut)
def get_set(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    return _set_out(db, s)


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
    if db.query(models.HardwareSet).filter(models.HardwareSet.code == code,
                                           models.HardwareSet.archived == False).first():   # noqa: E712
        raise HTTPException(409, f"Set {code} already exists")
    s = models.HardwareSet(code=code, name=payload.name.strip(), description=payload.description,
                           fire_rated=payload.fire_rated, notes=payload.notes, created_by_id=cu.id)
    db.add(s); db.flush()
    _apply_items(db, s, payload.items)
    db.commit(); db.refresh(s)
    return _set_out(db, s)


@router.put("/sets/{sid}", response_model=SetOut)
def update_set(sid: int, payload: SetIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    code = payload.code.strip() or s.code
    clash = db.query(models.HardwareSet).filter(models.HardwareSet.code == code, models.HardwareSet.id != sid,
                                                models.HardwareSet.archived == False).first()   # noqa: E712
    if clash:
        raise HTTPException(409, f"Another set already uses code {code}")
    s.code, s.name = code, payload.name.strip() or s.name
    s.description, s.fire_rated, s.notes = payload.description, payload.fire_rated, payload.notes
    _apply_items(db, s, payload.items)
    db.commit(); db.refresh(s)
    return _set_out(db, s)


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
    return _set_out(db, s)


@router.delete("/sets/{sid}", status_code=204)
def archive_set(sid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    s = db.query(models.HardwareSet).get(sid)
    if not s:
        raise HTTPException(404, "Set not found")
    if _set_uses(db, sid):
        raise HTTPException(409, "This set is assigned to doors on a project. Reassign them first.")
    s.archived = True
    db.commit()
