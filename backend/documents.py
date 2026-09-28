"""
Datasheets and certificates on products, and the submittal pack they make.

A document is one PDF stored once (by content hash, so the same sheet dropped
in three folders is one document) and attached to every product it covers: a
datasheet usually serves a whole range, not a single code. On Produce schedule
the pack is a cover page listing every document with the products it is for,
then the documents themselves, in set order, each once.
"""
import hashlib
import io
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import models
from database import get_db

router = APIRouter(prefix="/api")
DOC_DIR = Path("uploads") / "documents"
KINDS = ("datasheet", "certificate")

# what makes a file a certificate rather than a datasheet, by its name or folder
_CERT = re.compile(r"(\bdops?\b|declaration|certif|\bcerts?\b|submittal)", re.I)
# the product code a sheet is named for: CDC7505, CH 311, CBH102R, ECO_TS-14 ...
_CODE = re.compile(r"^([A-Za-z]{1,6}[ \-_.]?\d[A-Za-z0-9.\-/]*)")


def kind_of(path_in_zip: str) -> str:
    return "certificate" if _CERT.search(path_in_zip) else "datasheet"


def title_of(name: str) -> str:
    t = re.sub(r"\.pdf$", "", name, flags=re.I)
    t = re.sub(r"\s*\(\d+\)\s*$", "", t)                 # OneDrive's "(2)"
    t = re.sub(r"[_]+", " ", t)
    return " ".join(t.split())


def _flat(s: str) -> str:
    return re.sub(r"[\s._\-/]+", "", (s or "").lower())


def matches(stem: str, index: list) -> list[tuple]:
    """Products a sheet is for, best first. A code at the front of the name is
    trusted: the exact code, and every code that carries on from it (CDC624 also
    covers CDC624 SSS). Failing that, the words in the name give one guess."""
    from schedule import _suggest_product
    out: dict[int, tuple] = {}
    m = _CODE.match(stem.strip())
    code = _flat(m.group(1)) if m else ""
    if len(code) >= 4:
        for p, keys, _toks in index:
            for k in keys:
                if not k:
                    continue
                if k == code:
                    out[p.id] = (p, 1.0)
                elif k.startswith(code) and out.get(p.id, (None, 0))[1] < 0.9:
                    out[p.id] = (p, 0.9)
    if not out:
        s = _suggest_product(stem, index)
        if s:
            out[s[0].id] = s
    return sorted(out.values(), key=lambda x: -x[1])[:12]


def _pages(path: Path) -> int:
    try:
        import pymupdf
        with pymupdf.open(path) as d:
            return len(d)
    except Exception:
        return 0


def _store(data: bytes, original: str, kind: str, db: Session) -> tuple:
    """The document row for these bytes: the one already here, or a new one."""
    sha = hashlib.sha1(data).hexdigest()
    doc = db.query(models.Document).filter(models.Document.sha1 == sha).first()
    if doc:
        return doc, False
    DOC_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"{sha}.pdf"
    (DOC_DIR / fname).write_bytes(data)
    doc = models.Document(sha1=sha, filename=fname, original_name=Path(original).name[:200],
                          title=title_of(Path(original).name)[:200], kind=kind, pages=_pages(DOC_DIR / fname))
    db.add(doc); db.flush()
    return doc, True


def _doc_out(d: models.Document) -> dict:
    return {"id": d.id, "title": d.title, "original_name": d.original_name, "kind": d.kind, "pages": d.pages,
            "url": f"/api/files/documents/{d.id}",
            "products": [{"product_id": l.product_id, "sku": l.product.sku} for l in d.products]}


# ── Import ────────────────────────────────────────────────────────────────────
@router.post("/products/import-documents")
async def import_documents(file: UploadFile = File(...), dry_run: bool = False,
                           db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A zip of datasheets and certificates, any folder layout. Each PDF is kept
    once, attached to the products its name is for, and the rest wait on the
    Match datasheets screen. With dry_run nothing is kept: the answer says what
    would land where, and names every file that would not, so it can be looked
    at before a single sheet is stored."""
    from schedule import _product_index
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "Upload a .zip of the datasheet folders")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    stored = duplicates = links = certificates = 0
    attached_docs: set = set()
    placed: list[dict] = []          # name -> the products it goes on
    unplaced: list[dict] = []        # name, kind, best guess if any
    seen_sha: set[str] = set()
    try:
        shutil.copyfileobj(file.file, tmp); tmp.close()
        try:
            zf = zipfile.ZipFile(tmp.name)
        except zipfile.BadZipFile:
            raise HTTPException(400, "That file is not a zip")
        index = _product_index(db)
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = Path(info.filename).name
            if name.startswith(".") or "__MACOSX" in info.filename or not name.lower().endswith(".pdf"):
                continue
            with zf.open(info) as src:
                data = src.read()
            if not data.startswith(b"%PDF"):
                continue
            kind = kind_of(info.filename)
            if dry_run:
                sha = hashlib.sha1(data).hexdigest()
                if sha in seen_sha or db.query(models.Document.id).filter(models.Document.sha1 == sha).first():
                    duplicates += 1
                    continue
                seen_sha.add(sha)
                doc_key = sha
            else:
                doc, fresh = _store(data, info.filename, kind, db)
                if not fresh:
                    duplicates += 1
                    continue
                doc_key = doc.id
            stored += 1
            if kind == "certificate":
                certificates += 1
            found = matches(Path(name).stem, index)
            strong = [(p, sc) for p, sc in found if sc >= 0.9]
            for p, _sc in strong:
                if not dry_run:
                    db.add(models.ProductDocument(product_id=p.id, document_id=doc_key))
                links += 1; attached_docs.add(doc_key)
            if strong:
                placed.append({"name": title_of(name), "kind": kind, "skus": [p.sku for p, _ in strong]})
            else:
                unplaced.append({"name": title_of(name), "kind": kind,
                                 "guess": f"{found[0][0].sku}" if found else ""})
        if dry_run:
            db.rollback()
        else:
            db.commit()
    finally:
        try: Path(tmp.name).unlink()
        except OSError: pass
    return {"dry_run": dry_run, "stored": stored, "duplicates": duplicates, "attached": len(attached_docs),
            "links": links, "unmatched": stored - len(attached_docs), "certificates": certificates,
            "placed": placed, "unplaced": unplaced}


# ── The ones still to place ───────────────────────────────────────────────────
@router.get("/products/documents/pending")
def pending_documents(offset: int = 0, limit: int = 40, db: Session = Depends(get_db),
                      cu=Depends(auth.get_current_user)):
    from schedule import _product_index
    q = db.query(models.Document).filter(~models.Document.products.any()).order_by(models.Document.title)
    total = q.count()
    index = _product_index(db)
    items = []
    for d in q.offset(offset).limit(limit).all():
        sugg = [{"product_id": p.id, "sku": p.sku, "name": p.name, "score": round(sc, 2)}
                for p, sc in matches(Path(d.original_name).stem, index)]
        items.append({**_doc_out(d), "suggestions": sugg})
    return {"total": total, "items": items}


class AttachIn(BaseModel):
    product_ids: list[int] = []


@router.post("/products/documents/{did}/attach")
def attach_document(did: int, payload: AttachIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    d = db.query(models.Document).get(did)
    if not d:
        raise HTTPException(404, "Document not found")
    have = {l.product_id for l in d.products}
    n = 0
    for pid in payload.product_ids:
        if pid in have or not db.query(models.Product).get(pid):
            continue
        db.add(models.ProductDocument(product_id=pid, document_id=d.id)); have.add(pid); n += 1
    db.commit(); db.refresh(d)
    return {"attached": n, "document": _doc_out(d)}


class DocumentIn(BaseModel):
    kind: Optional[str] = None; title: Optional[str] = None


@router.put("/products/documents/{did}")
def update_document(did: int, payload: DocumentIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    d = db.query(models.Document).get(did)
    if not d:
        raise HTTPException(404, "Document not found")
    if payload.kind is not None:
        if payload.kind not in KINDS:
            raise HTTPException(400, "Kind must be datasheet or certificate")
        d.kind = payload.kind
    if payload.title is not None and payload.title.strip():
        d.title = payload.title.strip()[:200]
    db.commit(); db.refresh(d)
    return _doc_out(d)


@router.delete("/products/documents/{did}", status_code=204)
def delete_document(did: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The document goes altogether, off every product it was on."""
    d = db.query(models.Document).get(did)
    if not d:
        raise HTTPException(404, "Document not found")
    try: (DOC_DIR / d.filename).unlink()
    except OSError: pass
    db.delete(d); db.commit()


# ── On one product ────────────────────────────────────────────────────────────
@router.get("/products/{pid}/documents")
def product_documents(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = db.query(models.Product).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    links = db.query(models.ProductDocument).filter(models.ProductDocument.product_id == pid).all()
    return [_doc_out(l.document) for l in sorted(links, key=lambda l: (l.document.kind, l.document.title))]


@router.post("/products/{pid}/documents", status_code=201)
async def add_product_document(pid: int, file: UploadFile = File(...), kind: str = Form("datasheet"),
                               db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = db.query(models.Product).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    if kind not in KINDS:
        raise HTTPException(400, "Kind must be datasheet or certificate")
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "That file is not a PDF")
    doc, _fresh = _store(data, file.filename or "document.pdf", kind, db)
    if not any(l.product_id == pid for l in doc.products):
        db.add(models.ProductDocument(product_id=pid, document_id=doc.id))
    db.commit(); db.refresh(doc)
    return _doc_out(doc)


@router.delete("/products/{pid}/documents/{did}", status_code=204)
def unlink_document(pid: int, did: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Off this product only. A document nothing is left on goes altogether."""
    link = db.query(models.ProductDocument).filter_by(product_id=pid, document_id=did).first()
    if not link:
        raise HTTPException(404, "Not on this product")
    d = link.document
    db.delete(link); db.flush()
    if not d.products:
        try: (DOC_DIR / d.filename).unlink()
        except OSError: pass
        db.delete(d)
    db.commit()


@router.get("/files/documents/{did}")
def document_file(did: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    d = db.query(models.Document).get(did)
    if not d or not (DOC_DIR / d.filename).exists():
        raise HTTPException(404, "Document not found")
    safe = re.sub(r"[^A-Za-z0-9 ._\-]+", "_", d.title or "document")[:80]
    return FileResponse(str(DOC_DIR / d.filename), media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="{safe}.pdf"'})


# ── The submittal pack ────────────────────────────────────────────────────────
def _pack_plan(db: Session, data: dict, kinds: set) -> tuple[list, list]:
    """Documents in the order the products come on the schedule, each once, and
    the products that have no datasheet at all."""
    order, seen = [], set()
    for s in data["sets"]:
        for it in s["items"]:
            if it["product_id"] not in seen:
                seen.add(it["product_id"]); order.append(it)
    links = db.query(models.ProductDocument).filter(models.ProductDocument.product_id.in_(list(seen))).all() if seen else []
    by_product: dict[int, list] = {}
    for l in links:
        by_product.setdefault(l.product_id, []).append(l.document)
    docs, have, missing = [], set(), []
    for it in order:
        mine = [d for d in by_product.get(it["product_id"], []) if d.kind in kinds]
        if "datasheet" in kinds and not any(d.kind == "datasheet" for d in by_product.get(it["product_id"], [])):
            missing.append(it["sku"])
        for d in sorted(mine, key=lambda d: (d.kind != "datasheet", d.title)):
            if d.id not in have:
                have.add(d.id)
                docs.append((d, [l.product.sku for l in d.products if l.product_id in seen]))
    return docs, missing


@router.get("/projects/{pid}/schedule/pack-status")
def pack_status(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    from schedule import _own_project
    from schedule_output import build_schedule
    p = _own_project(pid, db, cu)
    data = build_schedule(db, p, estimator=cu.name)
    ds, missing = _pack_plan(db, data, {"datasheet"})
    certs, _ = _pack_plan(db, data, {"certificate"})
    return {"datasheets": len(ds), "certificates": len(certs), "missing": missing}


@router.get("/projects/{pid}/schedule/pack")
def schedule_pack(pid: int, datasheets: bool = True, certificates: bool = False,
                  db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The schedule's documents as one PDF for the architect: a cover listing
    what is inside and which products each is for, then the documents."""
    import pymupdf
    from schedule import _own_project, _safe_name
    from schedule_output import COMPANY, RULE, SchedulePDF, _latin, build_schedule
    kinds = {k for k, on in (("datasheet", datasheets), ("certificate", certificates)) if on}
    if not kinds:
        raise HTTPException(400, "Choose datasheets, certificates or both")
    p = _own_project(pid, db, cu)
    data = build_schedule(db, p, estimator=cu.name)
    docs, missing = _pack_plan(db, data, kinds)
    if not docs:
        raise HTTPException(409, "No documents are attached to the products on this schedule yet")

    label = " and ".join(k + "s" for k in ("datasheet", "certificate") if k in kinds)
    total_pages = 1 + sum(d.pages for d, _ in docs)

    class Cover(SchedulePDF):
        # the cover is numbered as page 1 of the whole pack, not of itself
        def footer(self):
            self.set_font("Helvetica", "", 8); self._muted(); self.set_draw_color(*RULE)
            self.set_y(-24); self.line(18, self.get_y(), 192, self.get_y())
            y = self.get_y() + 1.5
            for i, line in enumerate([COMPANY["name"], *COMPANY["address"], f"{COMPANY['phone']} {COMPANY['web']}"]):
                self.set_xy(18, y + i * 3.6); self.cell(120, 3.6, line)
            self.set_xy(150, y); self.cell(42, 3.6, self.data["project"]["date"], align="R")
            self.set_xy(150, y + 3.6); self.cell(42, 3.6, f"Page 1/{total_pages}", align="R")
            self._ink()

    pdf = Cover(data, priced=False, title=f"Submittal pack: {label}")
    pdf.add_page()
    pdf.band("Contents", "", f"{len(docs)} document{'s' if len(docs) != 1 else ''}")
    pdf.set_y(pdf.get_y() + 4)
    for i, (d, skus) in enumerate(docs, 1):
        pdf._need(11)
        y = pdf.get_y()
        pdf.set_font("Helvetica", "B", 9); pdf._ink(); pdf.set_xy(20, y); pdf.cell(8, 5, str(i))
        pdf.set_xy(28, y); pdf.cell(120, 5, _latin(d.title[:80]))
        pdf.set_font("Helvetica", "", 8); pdf._muted()
        pdf.set_xy(150, y); pdf.cell(42, 5, f"{d.kind} · {d.pages} pp", align="R")
        pdf.set_xy(28, y + 5); pdf.multi_cell(160, 4, _latin("For: " + ", ".join(skus)))
        pdf._ink(); pdf.set_y(pdf.get_y() + 2)
    if missing and "datasheet" in kinds:
        pdf._need(14)
        pdf.set_y(pdf.get_y() + 4)
        y = pdf.get_y()
        pdf.set_font("Helvetica", "B", 8.5); pdf._navy(); pdf.set_xy(18, y); pdf.cell(172, 5, "No datasheet on file yet")
        pdf.set_font("Helvetica", "", 8.5); pdf._muted(); pdf.set_xy(18, y + 6); pdf.multi_cell(172, 4, _latin(", ".join(missing)))
        pdf._ink()
    cover = pdf.output()

    out = pymupdf.open()
    out.insert_pdf(pymupdf.open(stream=bytes(cover), filetype="pdf"))
    for d, _skus in docs:
        try:
            with pymupdf.open(DOC_DIR / d.filename) as src:
                out.insert_pdf(src)
        except Exception:
            continue          # a sheet that cannot be read is listed on the cover and left out
    body = out.tobytes(garbage=3, deflate=True)
    out.close()
    return Response(body, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{_safe_name(p, "Submittal_Pack")}.pdf"'})
