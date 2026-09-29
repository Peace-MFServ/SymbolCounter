"""
Datasheets and certificates on products, and the submittal pack they make.

A document is one PDF stored once (by content hash, so the same sheet dropped
in three folders is one document) and attached to every product it covers: a
datasheet usually serves a whole range, not a single code. On Produce schedule
the pack is a cover page listing every document with the products it is for,
then the documents themselves, in set order, each once.
"""
import difflib
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
    covers CDC624 SSS). The supplier's own habit of a finish digit on the end
    (DS753 is the DS75 sheet, CDS753 the CDS75 one) is a strong suggestion, not
    a certainty. Failing that, the words in the name give one guess, which is
    never enough to attach a sheet on its own."""
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
            base = (_segments(p.sku) or [""])[0]
            if (p.id not in out and len(base) >= 4 and not base.isdigit()
                    and code[:-1] == base and code[-1].isdigit()):
                out[p.id] = (p, 0.85)
    if not out:
        s = _suggest_product(stem, index)
        if s:
            p, score = s
            # a code only counts where a word starts it: DS75 inside CDS753 is not DS75
            words = [w for w in re.split(r"[^a-z0-9]+", stem.lower()) if w]
            starts = ["".join(words[i:]) for i in range(len(words))]
            keys = next((ks for q, ks, _t in index if q.id == p.id), [])
            if score >= 0.9 and not any(st.startswith(k) for st in starts for k in keys if len(k) >= 4):
                score = 0.5
            out[p.id] = (p, min(score, 0.8))
    return sorted(out.values(), key=lambda x: -x[1])[:12]


# ── Reading inside the PDF ────────────────────────────────────────────────────
# A code as a datasheet prints it: one or two groups of capitals, then a digit,
# then more of the code with its dots and dashes: CBH102R, CBH 102R, ECO TS 14,
# CPHH15.04.BT.SSS, CH100.W/O.SSS. And long plain numbers such as 28730.
_IN_TEXT = re.compile(r"(?<![A-Za-z0-9])((?:[A-Z]{1,6}[ \-]?){1,2}\d[A-Z0-9]*(?:[./\-][A-Z0-9]+)*)")
_NUMBER = re.compile(r"(?<![\w.])(\d{5,}(?:[./\-][A-Z0-9]+)*)(?![\w])")
READ_PAGES = 20            # a datasheet lists its codes early; a 200-page brochure is not read to the end
BROCHURE = 25              # a document naming more of our products than this is a catalogue, not a sheet


def read_codes(data: bytes) -> tuple:
    """(has_text, codes): every product-code-shaped string printed in the PDF."""
    try:
        import pymupdf
        with pymupdf.open(stream=data, filetype="pdf") as d:
            text = "\n".join(d[i].get_text() for i in range(min(len(d), READ_PAGES)))
    except Exception:
        return False, []
    if len("".join(text.split())) < 10:
        return False, []                     # a scan: pictures of text, nothing to read
    found = {m.group(1).strip() for m in _IN_TEXT.finditer(text)}
    found |= {m.group(1) for m in _NUMBER.finditer(text)}
    return True, sorted(c for c in found if len(_flat(c)) >= 4 and any(ch.isdigit() for ch in c))


def _segments(code: str) -> list:
    """A product code cut back at each separator: CPHH15.04.BT.SSS gives cphh15,
    cphh1504, cphh1504bt and the whole. CH3112.4 gives ch3112, never ch311."""
    parts = [p for p in re.split(r"[\s._\-/]+", (code or "").lower()) if p]
    return ["".join(parts[:i]) for i in range(1, len(parts) + 1)]


def content_index(db: Session) -> dict:
    """Every way a product's code can be printed, to the product and how sure that is."""
    idx: dict = {}
    for p in db.query(models.Product).filter(models.Product.active == True).all():   # noqa: E712
        for code in (p.sku, p.intec_code):
            segs = _segments(code)
            if not segs:
                continue
            whole = segs[-1]
            if len(whole) >= 4:
                idx.setdefault(whole, {})[p.id] = (p, 1.0)          # the full code, printed
            for part in segs[:-1]:
                if len(part) >= 4 and any(ch.isdigit() for ch in part) and not part.isdigit():
                    idx.setdefault(part, {}).setdefault(p.id, (p, 0.8))   # the range the code belongs to
    return idx


def content_matches(codes: list, idx: dict) -> tuple:
    """(products the printed codes point at, best first, as (product, score, seen as);
    whether it reads like a catalogue)."""
    out: dict = {}
    for c in codes:
        for p, score in idx.get(_flat(c), {}).values():
            if p.id not in out or out[p.id][1] < score:
                out[p.id] = (p, score, c)
    ranked = sorted(out.values(), key=lambda x: (-x[1], x[0].sku))
    exact = sum(1 for x in ranked if x[1] >= 1.0)
    return ranked, exact > BROCHURE


def ensure_read(d: models.Document) -> None:
    """Read a stored document once and remember what it said."""
    if d.has_text is not None:
        return
    try:
        data = (DOC_DIR / d.filename).read_bytes()
    except OSError:
        d.has_text = False; d.codes = ""
        return
    d.has_text, codes = read_codes(data)
    d.codes = "\n".join(codes)


def stored_codes(d: models.Document) -> list:
    # one code a line: a code can have spaces in it (ECO TS 14)
    return [c for c in (d.codes or "").split("\n") if c.strip()]


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
        cidx = content_index(db)
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
            has_text, printed = read_codes(data)
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
                doc.has_text = has_text
                doc.codes = "\n".join(printed)
                doc_key = doc.id
            stored += 1
            if kind == "certificate":
                certificates += 1
            found = matches(Path(name).stem, index)
            strong = [(p, sc) for p, sc in found if sc >= 0.9]
            if kind == "datasheet":
                # what the sheet itself prints, unless it reads like a catalogue
                inside, catalogue = content_matches(printed, cidx)
                if not catalogue:
                    have = {p.id for p, _ in strong}
                    strong += [(p, sc) for p, sc, _seen in inside if p.id not in have]
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
def _proposals(d: models.Document, index: list, cidx: dict) -> tuple:
    """Suggestions for a waiting document: from what it prints, then from its name.
    Returns (suggestions, catalogue)."""
    out, catalogue = {}, False
    if d.kind == "datasheet" and d.has_text:
        inside, catalogue = content_matches(stored_codes(d), cidx)
        for p, sc, seen in inside:
            out[p.id] = {"product_id": p.id, "sku": p.sku, "name": p.name, "score": sc,
                         "source": "sheet", "seen_as": seen}
    for p, sc in matches(Path(d.original_name).stem, index):
        if p.id not in out:
            out[p.id] = {"product_id": p.id, "sku": p.sku, "name": p.name, "score": round(sc, 2),
                         "source": "name", "seen_as": ""}
    ranked = sorted(out.values(), key=lambda x: (x["source"] != "sheet", -x["score"], x["sku"]))
    return ranked[:40], catalogue


@router.get("/products/documents/pending")
def pending_documents(offset: int = 0, limit: int = 40, db: Session = Depends(get_db),
                      cu=Depends(auth.get_current_user)):
    from schedule import _product_index
    q = db.query(models.Document).filter(~models.Document.products.any()).order_by(models.Document.title)
    total = q.count()
    unread = q.filter(models.Document.has_text.is_(None)).count()
    index, cidx = _product_index(db), content_index(db)
    items = []
    for d in q.offset(offset).limit(limit).all():
        sugg, catalogue = _proposals(d, index, cidx)
        items.append({**_doc_out(d), "suggestions": sugg, "has_text": d.has_text, "catalogue": catalogue})
    return {"total": total, "unread": unread, "items": items}


@router.post("/products/documents/read")
def read_waiting(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Open every document not read yet and note the product codes it prints."""
    docs = db.query(models.Document).filter(models.Document.has_text.is_(None)).all()
    scans = 0
    for i, d in enumerate(docs, 1):
        ensure_read(d)
        scans += 0 if d.has_text else 1
        if i % 20 == 0:
            db.commit()
    db.commit()
    return {"read": len(docs), "scans": scans}


@router.post("/products/documents/attach-found")
def attach_found(apply: bool = False, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Every waiting datasheet onto the products it prints the codes of. Without
    apply, only says what it would do. Catalogues and scans are left for a person."""
    cidx = content_index(db)
    plan, catalogues, links = [], 0, 0
    for d in db.query(models.Document).filter(~models.Document.products.any(),
                                              models.Document.kind == "datasheet",
                                              models.Document.has_text == True).order_by(models.Document.title).all():   # noqa: E712
        inside, catalogue = content_matches(stored_codes(d), cidx)
        if catalogue:
            catalogues += 1
            continue
        if not inside:
            continue
        plan.append({"document_id": d.id, "title": d.title,
                     "products": [{"product_id": p.id, "sku": p.sku, "seen_as": seen} for p, _sc, seen in inside]})
        links += len(inside)
        if apply:
            for p, _sc, _seen in inside:
                db.add(models.ProductDocument(product_id=p.id, document_id=d.id, confirmed=True))
    if apply:
        db.commit()
    return {"applied": apply, "documents": len(plan), "links": links, "catalogues": catalogues, "plan": plan}


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
        db.add(models.ProductDocument(product_id=pid, document_id=d.id, confirmed=True)); have.add(pid); n += 1
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
        db.add(models.ProductDocument(product_id=pid, document_id=doc.id, confirmed=True))
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
            missing.append({"product_id": it["product_id"], "sku": it["sku"], "name": it["name"]})
        for d in sorted(mine, key=lambda d: (d.kind != "datasheet", d.title)):
            if d.id not in have:
                have.add(d.id)
                docs.append((d, [l.product.sku for l in d.products if l.product_id in seen]))
    # The same sheet filed twice under two names (an older and a newer layout)
    # goes in once: the fuller copy, for every product either was on.
    cache: dict = {}
    kept: list = []
    for d, skus in docs:
        twin = next((k for k in kept if d.kind == "datasheet" and k[0].kind == "datasheet"
                     and set(k[1]) & set(skus) and same_sheet(k[0], d, cache)), None)
        if twin is None:
            kept.append([d, skus])
            continue
        if _fuller(d, cache) > _fuller(twin[0], cache):
            twin[0] = d
        twin[1] = twin[1] + [s for s in skus if s not in twin[1]]
    return [(d, skus) for d, skus in kept], missing


# ── The same sheet twice ──────────────────────────────────────────────────────
SAME_SHEET = 0.9          # this much of the text alike, letters and numbers only, is one sheet


def _sheet_text(d: models.Document, cache: dict) -> str:
    if d.id not in cache:
        try:
            import pymupdf
            with pymupdf.open(DOC_DIR / d.filename) as f:
                t = " ".join(f[i].get_text() for i in range(min(len(f), 3)))
        except Exception:
            t = ""
        cache[d.id] = re.sub(r"[^a-z0-9]+", "", t.lower())
    return cache[d.id]


def same_sheet(a: models.Document, b: models.Document, cache: dict) -> bool:
    """Two documents that say the same thing: a sheet saved twice, or reissued
    in a new layout. A drawing with no words in it is never called a copy."""
    ta, tb = _sheet_text(a, cache), _sheet_text(b, cache)
    if len(ta) < 80 or len(tb) < 80:
        return False
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    return sm.real_quick_ratio() >= SAME_SHEET and sm.quick_ratio() >= SAME_SHEET and sm.ratio() >= SAME_SHEET


def _fuller(d: models.Document, cache: dict) -> tuple:
    """Which of two copies to keep: the one that says more, then the newer."""
    return (len(_sheet_text(d, cache)), d.id)


@router.get("/projects/{pid}/schedule/pack-status")
def pack_status(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    from schedule import _own_project
    from schedule_output import build_schedule
    p = _own_project(pid, db, cu)
    data = build_schedule(db, p, estimator=cu.name)
    ds, missing = _pack_plan(db, data, {"datasheet"})
    certs, _ = _pack_plan(db, data, {"certificate"})
    import submittal_cover
    return {"datasheets": len(ds), "certificates": len(certs), "missing": missing, "cover": submittal_cover.saved()}


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

    import submittal_cover
    if submittal_cover.saved()["cover"]:
        # the office's own cover with this job on it, the sheets, and the back page
        front = submittal_cover.fill(p.name, p.site or "", p.client or "")
        out = pymupdf.open()
        out.insert_pdf(front, from_page=0, to_page=0)
        for d, _skus in docs:
            try:
                with pymupdf.open(DOC_DIR / d.filename) as src:
                    out.insert_pdf(src)
            except Exception:
                continue
        if len(front) > 1:
            out.insert_pdf(front, from_page=len(front) - 1, to_page=len(front) - 1)
        body = out.tobytes(garbage=3, deflate=True)
        out.close(); front.close()
        return Response(body, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{_safe_name(p, "Submittal_Pack")}.pdf"'})

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
        pdf.set_font("Helvetica", "", 8.5); pdf._muted(); pdf.set_xy(18, y + 6); pdf.multi_cell(172, 4, _latin(", ".join(m["sku"] for m in missing)))
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


# ── Checking what is on the products ─────────────────────────────────────────
@router.get("/products/documents/check")
def check_documents(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Two things worth a look across the whole product file: the same sheet on
    a product twice, and a sheet on a product that nothing backs up, neither
    its name nor a code printed in it, and that no person put there."""
    from schedule import _product_index
    index, cidx, cache = _product_index(db), content_index(db), {}
    links = db.query(models.ProductDocument).all()
    by_product: dict = {}
    for l in links:
        by_product.setdefault(l.product_id, []).append(l)

    doubles = []
    for pid, ls in by_product.items():
        sheets = sorted((l.document for l in ls if l.document.kind == "datasheet"), key=lambda d: _fuller(d, cache), reverse=True)
        if len(sheets) < 2:
            continue
        kept, drop = [], []
        for d in sheets:
            twin = next((k for k in kept if same_sheet(k, d, cache)), None)
            if twin:
                drop.append({"document_id": d.id, "title": d.title, "url": f"/api/files/documents/{d.id}", "same_as": twin.title})
            else:
                kept.append(d)
        if drop:
            p = ls[0].product
            doubles.append({"product_id": pid, "sku": p.sku, "name": p.name,
                            "keep": {"document_id": kept[0].id, "title": kept[0].title, "url": f"/api/files/documents/{kept[0].id}"},
                            "drop": drop})

    dropping = {(x["product_id"], y["document_id"]) for x in doubles for y in x["drop"]}
    doubtful = []
    for l in links:
        d = l.document
        if l.confirmed or d.kind != "datasheet" or (l.product_id, d.id) in dropping:
            continue
        ensure_read(d)
        if d.has_text:
            inside, _cat = content_matches(stored_codes(d), cidx)
            if any(p.id == l.product_id for p, _sc, _seen in inside):
                continue
        named = matches(Path(d.original_name or d.title).stem, index)
        if any(p.id == l.product_id and sc >= 0.85 for p, sc in named):
            continue
        better = next((p for p, sc in named if sc >= 0.85 and p.id != l.product_id), None)
        doubtful.append({"product_id": l.product_id, "sku": l.product.sku, "name": l.product.name,
                         "document_id": d.id, "title": d.title, "url": f"/api/files/documents/{d.id}",
                         "move_to": {"product_id": better.id, "sku": better.sku, "name": better.name} if better else None})
    db.commit()                     # anything read along the way is remembered
    doubles.sort(key=lambda x: x["sku"]); doubtful.sort(key=lambda x: (x["sku"], x["title"]))
    return {"doubles": doubles, "doubtful": doubtful}


class LinkFix(BaseModel):
    product_id: int; document_id: int; to_product_id: Optional[int] = None


class CheckApplyIn(BaseModel):
    drop: list[LinkFix] = []        # a second copy of a sheet: off the product, and gone if on nothing else
    remove: list[LinkFix] = []      # off the product, back to Match datasheets if on nothing else
    move: list[LinkFix] = []        # off this product, onto to_product_id
    keep: list[LinkFix] = []        # right where it is: stop asking


@router.post("/products/documents/check")
def apply_document_check(payload: CheckApplyIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    def link(f):
        return db.query(models.ProductDocument).filter_by(product_id=f.product_id, document_id=f.document_id).first()
    gone = moved = kept = 0
    emptied = set()
    for f in payload.drop + payload.remove + payload.move:
        l = link(f)
        if not l:
            continue
        if f in payload.move and f.to_product_id and db.query(models.Product).get(f.to_product_id):
            if not db.query(models.ProductDocument).filter_by(product_id=f.to_product_id, document_id=f.document_id).first():
                db.add(models.ProductDocument(product_id=f.to_product_id, document_id=f.document_id, confirmed=True))
            moved += 1
        else:
            gone += 1
        if f in payload.drop:
            emptied.add(f.document_id)
        db.delete(l)
    for f in payload.keep:
        l = link(f)
        if l:
            l.confirmed = True; kept += 1
    db.flush()
    deleted = 0
    for did in emptied:
        d = db.query(models.Document).get(did)
        if d and not d.products:
            try: (DOC_DIR / d.filename).unlink()
            except OSError: pass
            db.delete(d); deleted += 1
    db.commit()
    return {"removed": gone, "moved": moved, "kept": kept, "deleted": deleted}


# ── The office's cover and back page ─────────────────────────────────────────
@router.get("/submittal/cover")
def cover_status(cu=Depends(auth.get_current_user)):
    import submittal_cover
    return submittal_cover.saved()


@router.post("/submittal/cover")
async def cover_upload(file: UploadFile = File(...), cu=Depends(auth.get_current_user)):
    """A PDF whose first page is the cover and last page the back: a pack sent before will do."""
    import submittal_cover
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "That file is not a PDF")
    try:
        return submittal_cover.save(data)
    except Exception as e:
        raise HTTPException(400, f"Could not use that PDF: {e}")


@router.delete("/submittal/cover", status_code=204)
def cover_remove(cu=Depends(auth.get_current_user)):
    import submittal_cover
    try: submittal_cover.COVER_FILE.unlink()
    except OSError: pass


@router.get("/projects/{pid}/schedule/pack-cover")
def cover_for_job(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The cover and back page as they will be on this job's pack."""
    import submittal_cover
    from schedule import _own_project
    p = _own_project(pid, db, cu)
    if not submittal_cover.saved()["cover"]:
        raise HTTPException(404, "No cover page uploaded yet")
    d = submittal_cover.fill(p.name, p.site or "", p.client or "")
    body = d.tobytes(garbage=3, deflate=True); d.close()
    return Response(body, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="Submittal_cover.pdf"'})
