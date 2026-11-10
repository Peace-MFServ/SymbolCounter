"""
Reading the doors off a job's floor plans: upload, look over, add to the job.

A reading is kept on disk under uploads/plan_reads/<job>/<reading>: the PDFs
as they came, and which door tag styles the person settled on. The doors are
worked out again from the PDFs whenever they are asked for, so a change of
style is never out of step with the plans.
"""
import json
import re
import secrets
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import models
from database import get_db

router = APIRouter(prefix="/api", tags=["plan-reads"])
ROOT = Path("uploads") / "plan_reads"
MAX_FILES = 20


def _dir(pid: int, rid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", rid or ""):
        raise HTTPException(404, "Reading not found")
    d = ROOT / str(pid) / rid
    if not (d / "meta.json").exists():
        raise HTTPException(404, "Reading not found")
    return d


def _meta(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text())


def _files(d: Path, meta: dict) -> list[tuple[str, bytes]]:
    return [(name, (d / f"{i}.pdf").read_bytes()) for i, name in enumerate(meta["names"])]


_READER_STAMP = None


def _reader_stamp() -> str:
    """Changes whenever the reader's own code does, so a kept reading is never from an older reader."""
    global _READER_STAMP
    if _READER_STAMP is None:
        import hashlib
        import detection.plan_reader as pr
        _READER_STAMP = hashlib.sha1(Path(pr.__file__).read_bytes()).hexdigest()[:16]
    return _READER_STAMP


def _reading(pid: int, rid: str, d: Path, meta: dict) -> dict:
    """The doors read off the plans. Reading takes seconds, so the result is kept
    beside the plans and used again until the plans, the labels chosen or the
    reader itself change."""
    from detection.plan_reader import read_plans
    key = json.dumps([_reader_stamp(), meta["names"], meta.get("chosen") or None])
    kept = d / "reading.json"
    r = None
    if kept.exists():
        try:
            saved = json.loads(kept.read_text())
            if saved.get("key") == key:
                r = saved["r"]
        except (ValueError, KeyError):
            r = None
    if r is None:
        r = read_plans(_files(d, meta), meta.get("chosen") or None)
        if not meta.get("chosen"):
            meta["chosen"] = r["chosen"]
            (d / "meta.json").write_text(json.dumps(meta))
            key = json.dumps([_reader_stamp(), meta["names"], meta["chosen"]])
        try:
            kept.write_text(json.dumps({"key": key, "r": r}))
        except (TypeError, OSError):
            pass
    # doors a person added by hand, where the reader missed one: kept with the plans
    floor_of = {(p["file"], p["page"]): p.get("floor", "") for p in r["pages"]}
    r = {**r, "doors": list(r["doors"])}
    for m in meta.get("manual") or []:
        placed = m.get("x") is not None
        r["doors"].append({"id": m["id"], "ref": m["ref"], "file": m["file"], "page": m["page"],
                           "floor": floor_of.get((m["file"], m["page"]), ""),
                           "x": (m["x"] - 12) if placed else None, "y": (m["y"] - 7) if placed else None, "w": 24, "h": 14,
                           "family": None, "src": "manual", "status": "green", "reasons": [], "type": "", "also": []})
    return {"id": rid, "project_id": pid, "names": meta["names"], **r}


def _with_job(db: Session, pid: int, r: dict) -> dict:
    """Mark doors whose reference is already on the job, and send the job's doors
    with their sets so the page can show and change them."""
    from schedule import _effective_set_id
    job = {}
    for d in db.query(models.Door).filter(models.Door.project_id == pid).all():
        job[(d.ref or "").upper()] = {"id": d.id, "set_id": _effective_set_id(d)}
    for d in r["doors"]:
        d["on_job"] = d["ref"].upper() in job
    r["job_doors"] = job
    return r


def latest_reading(pid: int) -> str:
    """The id of the job's newest plan reading, or '' when it has none."""
    base = ROOT / str(pid)
    if not base.is_dir():
        return ""
    metas = [m for m in base.glob("*/meta.json") if re.fullmatch(r"[a-f0-9]{12}", m.parent.name)]
    return max(metas, key=lambda m: m.stat().st_mtime).parent.name if metas else ""


@router.get("/projects/{pid}/plan-reads")
def job_reading(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The job's plans as last read, so the page opens on them. {id: ''} when there are none."""
    from schedule import _own_project
    _own_project(pid, db, cu)
    rid = latest_reading(pid)
    if not rid:
        return {"id": ""}
    d = _dir(pid, rid)
    return _with_job(db, pid, _reading(pid, rid, d, _meta(d)))


@router.post("/projects/{pid}/plan-reads/{rid}/files")
async def add_plans(pid: int, rid: str, files: list[UploadFile] = File(...),
                    db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """More plans for the same job: they join the ones already read."""
    from schedule import _edit_project
    _edit_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    added = 0
    for f in files:
        if len(meta["names"]) >= MAX_FILES:
            break
        data = await f.read()
        name = Path(f.filename or "plan.pdf").name
        if not data.startswith(b"%PDF"):
            continue
        (d / f"{len(meta['names'])}.pdf").write_bytes(data)
        meta["names"].append(name); added += 1
    if not added:
        raise HTTPException(400, "Upload the floor plans as PDF files")
    if not meta.get("picked"):
        meta["chosen"] = None            # read afresh, so a new architect's sheet gets its own door numbers
    (d / "meta.json").write_text(json.dumps(meta))
    return _with_job(db, pid, _reading(pid, rid, d, meta))


@router.post("/projects/{pid}/plan-reads")
async def start_reading(pid: int, files: list[UploadFile] = File(...),
                        db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Upload the floor plans of a job; the door tags on them are read straight away."""
    from schedule import _edit_project
    _edit_project(pid, db, cu)
    pdfs = []
    for f in files[:MAX_FILES]:
        data = await f.read()
        if data.startswith(b"%PDF"):
            pdfs.append((Path(f.filename or "plan.pdf").name, data))
    if not pdfs:
        raise HTTPException(400, "Upload the floor plans as PDF files")
    rid = secrets.token_hex(6)
    d = ROOT / str(pid) / rid
    d.mkdir(parents=True, exist_ok=True)
    for i, (_, data) in enumerate(pdfs):
        (d / f"{i}.pdf").write_bytes(data)
    meta = {"names": [n for n, _ in pdfs], "chosen": None, "by": cu.id}
    (d / "meta.json").write_text(json.dumps(meta))
    return _with_job(db, pid, _reading(pid, rid, d, meta))


@router.get("/projects/{pid}/plan-reads/{rid}")
def get_reading(pid: int, rid: str, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    from schedule import _own_project
    _own_project(pid, db, cu)
    d = _dir(pid, rid)
    return _with_job(db, pid, _reading(pid, rid, d, _meta(d)))


class StylesIn(BaseModel):
    keys: list[str] = []


@router.put("/projects/{pid}/plan-reads/{rid}/styles")
def set_styles(pid: int, rid: str, payload: StylesIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Use these door tag styles: the doors are read again with them."""
    from schedule import _edit_project
    _edit_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    keys = [k for k in payload.keys if isinstance(k, str) and 0 < len(k) <= 40][:6]
    if not keys:
        raise HTTPException(400, "Choose at least one door tag style")
    meta["chosen"] = keys
    meta["picked"] = True                # a person chose: more plans added later do not undo it
    (d / "meta.json").write_text(json.dumps(meta))
    return _with_job(db, pid, _reading(pid, rid, d, meta))


@router.get("/projects/{pid}/plan-reads/{rid}/labels")
def sheet_labels(pid: int, rid: str, file: int = 0, page: int = 1,
                 db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Every label on one sheet, so a person can point at a door tag to teach the style."""
    from schedule import _own_project
    from detection.plan_reader import labels_at
    _own_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    if not (0 <= file < len(meta["names"])):
        raise HTTPException(404, "No such plan")
    return labels_at(_files(d, meta), file, page)


@router.get("/projects/{pid}/plan-reads/{rid}/sheet/{file}/{page}")
def sheet_image(pid: int, rid: str, file: int, page: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """One sheet as a picture, about 2400 pixels across, made once and kept."""
    import pymupdf
    from schedule import _own_project
    _own_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    if not (0 <= file < len(meta["names"])):
        raise HTTPException(404, "No such plan")
    out = d / f"{file}-{page}.png"
    if not out.exists():
        with pymupdf.open(d / f"{file}.pdf") as doc:
            if not (1 <= page <= len(doc)):
                raise HTTPException(404, "No such sheet")
            pg = doc[page - 1]
            zoom = min(4.0, 2400 / max(pg.rect.width, 1))
            pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).save(out)
    return Response(out.read_bytes(), media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


class ManualIn(BaseModel):
    ref: str
    file: int = 0
    page: int = 1
    x: Optional[float] = None       # where it is on the sheet, in the sheet's own points; none if it is on no sheet
    y: Optional[float] = None


@router.post("/projects/{pid}/plan-reads/{rid}/manual")
def add_door_by_hand(pid: int, rid: str, payload: ManualIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A door the reader missed: its number, and where it is on the plan."""
    from schedule import _edit_project
    _edit_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    ref = " ".join(payload.ref.split())[:60]
    if not ref:
        raise HTTPException(400, "Type the door's number")
    if not (0 <= payload.file < len(meta["names"])) or payload.page < 1:
        raise HTTPException(404, "No such sheet")
    manual = meta.setdefault("manual", [])
    if len(manual) >= 2000:
        raise HTTPException(400, "That is too many doors added by hand")
    if any(m["ref"].upper() == ref.upper() for m in manual):
        raise HTTPException(409, f"{ref} has already been added by hand")
    mid = "m." + secrets.token_hex(4)
    manual.append({"id": mid, "ref": ref, "file": payload.file, "page": payload.page, "x": payload.x, "y": payload.y})
    (d / "meta.json").write_text(json.dumps(meta))
    return {"added": mid, **_with_job(db, pid, _reading(pid, rid, d, meta))}


@router.delete("/projects/{pid}/plan-reads/{rid}/manual/{mid}")
def remove_door_by_hand(pid: int, rid: str, mid: str, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    from schedule import _edit_project
    _edit_project(pid, db, cu)
    d = _dir(pid, rid)
    meta = _meta(d)
    meta["manual"] = [m for m in meta.get("manual") or [] if m["id"] != mid]
    (d / "meta.json").write_text(json.dumps(meta))
    return _with_job(db, pid, _reading(pid, rid, d, meta))


class DoorIn(BaseModel):
    ref: str
    floor: str = ""
    note: str = ""
    set_id: Optional[int] = None      # this door's own set; without one it takes the set given for them all


class ApplyIn(BaseModel):
    doors: list[DoorIn] = []
    set_id: Optional[int] = None


@router.post("/projects/{pid}/plan-reads/{rid}/apply")
def add_doors(pid: int, rid: str, payload: ApplyIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The doors a person has looked over go onto the job. References already on it are left alone."""
    _dir(pid, rid)
    return _add_doors(pid, payload, db, cu, source="plans", note="Read from the floor plans")


def _add_doors(pid: int, payload: ApplyIn, db: Session, cu, source: str, note: str) -> dict:
    """The doors a person has looked over go onto the job. References already on it are left alone."""
    from schedule import _edit_project, _link_set, _usable_set
    p = _edit_project(pid, db, cu)
    # a library set or this job's own, never another job's
    for sid in {payload.set_id} | {d.set_id for d in payload.doors[:5000]}:
        if sid:
            _usable_set(db, pid, sid)
    used = set()
    have = {(x or "").upper() for (x,) in db.query(models.Door.ref).filter(models.Door.project_id == pid).all()}
    added, skipped = 0, []
    for dr in payload.doors[:5000]:
        ref = " ".join(dr.ref.split())[:60]
        if not ref:
            continue
        if ref.upper() in have:
            skipped.append(ref); continue
        sid = dr.set_id or payload.set_id or None
        db.add(models.Door(project_id=pid, ref=ref, floor=dr.floor.strip()[:60], set_id=sid,
                           source=source, note=(dr.note.strip() or note)[:500]))
        have.add(ref.upper()); added += 1
        if sid:
            used.add(sid)
    for sid in sorted(used):
        _link_set(db, pid, sid)
        db.flush()
    db.commit()
    return {"added": added, "skipped": skipped, "project": p.name,
            "job_doors": _with_job(db, pid, {"doors": []})["job_doors"]}


# ── A door list from the architect's spreadsheet ─────────────────────────────
SHEET_TYPES = (".xlsx", ".xlsm", ".csv")


@router.post("/projects/{pid}/door-list")
async def read_door_list_file(pid: int, file: UploadFile = File(...),
                              db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """An architect's door schedule as a spreadsheet: the doors in it, to look over before they are added."""
    from schedule import _edit_project
    from detection.door_list import read_door_list
    _edit_project(pid, db, cu)
    name = Path(file.filename or "schedule.xlsx").name
    if not name.lower().endswith(SHEET_TYPES):
        raise HTTPException(400, "Upload the door schedule as an Excel file (.xlsx) or a .csv")
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(400, "That file is too big")
    r = read_door_list(name, data)
    r["name"] = name
    return _with_job(db, pid, r)


@router.post("/projects/{pid}/door-list/apply")
def add_listed_doors(pid: int, payload: ApplyIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    return _add_doors(pid, payload, db, cu, source="schedule", note="From the architect's door schedule")
