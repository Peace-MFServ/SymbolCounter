"""
Jobs: the plans of one project, read for their doors, and the doors confirmed.

A job is made here by one of the team, or comes in from an architect through
the portal. A portal job waits in Incoming until someone takes it; whoever takes
it checks the doors and marks it checked.
"""
import io
import json
import os
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

import auth
import models
from database import get_db

router = APIRouter(prefix="/api", tags=["jobs"])
FILES_ROOT = Path("uploads") / "job_files"
# how long the team has from an architect sending plans in; the clock on Incoming
TURNAROUND_HOURS = int(os.getenv("TURNAROUND_HOURS", "48") or 48)


def utcnow() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.replace(tzinfo=None).isoformat() + "Z" if dt else None


# ── Who may do what ───────────────────────────────────────────────────────────
def own_project(pid: int, db: Session, cu) -> models.Project:
    """Anyone on the team can look at any job."""
    p = db.query(models.Project).filter(models.Project.id == pid).first()
    if not p:
        raise HTTPException(404, "Job not found")
    return p


def edit_project(pid: int, db: Session, cu) -> models.Project:
    """Only the job's owner changes it. A job sent in through the portal has no
    owner until someone takes it."""
    p = own_project(pid, db, cu)
    if p.owner_id and p.owner_id != cu.id:
        who = p.owner.name if p.owner else "its owner"
        raise HTTPException(403, f"{who} has this job. Only they can change it.")
    return p


# ── What a job looks like to the page ─────────────────────────────────────────
class ProjectOut(BaseModel):
    id: int
    name: str
    kind: str = "doors"              # doors: read from plans | symbols: device counting
    client: str = ""
    site: str = ""
    description: str = ""
    drawing_firm: str = ""
    quote_no: str = ""
    drawing_count: int = 0           # device counting
    verified_count: int = 0
    approved_count: int = 0
    source: str = ""
    stage: str = ""
    brief: str = ""
    contact: dict = {}
    received_at: Optional[str] = None
    due_at: Optional[str] = None
    checked_at: Optional[str] = None
    plan_read: str = ""              # the newest reading of its plans, if any
    draft: dict = {}                 # what the reader made of the plans: {green, amber}
    door_count: int = 0              # doors confirmed
    files: list = []                 # what the architect sent, as sent
    owner_id: Optional[int] = None
    owner_name: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _draft(pid: int, rid: str) -> dict:
    """What was read from what the architect sent: doors on the plans, and doors in a door schedule."""
    listed = sum(f.get("doors") or 0 for f in job_files(pid) if f.get("kind") in ("xlsx", "csv"))
    out = _plans_draft(pid, rid)
    if listed:
        out["listed"] = listed
    return out


def _plans_draft(pid: int, rid: str) -> dict:
    from plan_reads import ROOT
    kept = ROOT / str(pid) / rid / "reading.json"
    if not rid or not kept.exists():
        return {}
    try:
        r = json.loads(kept.read_text())["r"]
        t = r.get("totals") or {}
        # a sheet that is a scan has doors on it that were never read: never left unsaid
        bad = [p.get("name", "") for p in r.get("pages", []) if not p.get("readable", True)]
        return {"green": t.get("green", 0), "amber": t.get("amber", 0), "unreadable": len(bad)}
    except (ValueError, KeyError, OSError):
        return {}


def job_files(pid: int) -> list[dict]:
    idx = FILES_ROOT / str(pid) / "index.json"
    try:
        return json.loads(idx.read_text()) if idx.exists() else []
    except (ValueError, OSError):
        return []


def project_out(p: models.Project, db: Session, full: bool = True) -> ProjectOut:
    from plan_reads import latest_reading
    rid = latest_reading(p.id)
    try:
        contact = json.loads(p.contact) if p.contact else {}
    except ValueError:
        contact = {}
    drawings = p.drawings if (p.kind or "symbols") == "symbols" else []
    return ProjectOut(
        id=p.id, name=p.name, kind=p.kind or "symbols", client=p.client or "", site=p.site or "",
        description=p.description or "", drawing_firm=p.drawing_firm or "", quote_no=p.quote_no or "",
        drawing_count=len(drawings), verified_count=sum(1 for d in drawings if d.status in ("verified", "approved")),
        approved_count=sum(1 for d in drawings if d.status == "approved"),
        source=p.source or "", stage=p.stage or "", brief=(p.brief or "") if full else (p.brief or "")[:200],
        contact=contact, received_at=iso(p.received_at), due_at=iso(p.due_at), checked_at=iso(p.checked_at),
        plan_read=rid, draft=_draft(p.id, rid),
        door_count=db.query(models.Door).filter(models.Door.project_id == p.id).count(),
        files=[{k: f.get(k) for k in ("name", "size", "kind", "pages", "unreadable", "doors")} for f in job_files(p.id)] if full else [],
        owner_id=p.owner_id, owner_name=p.owner.name if p.owner else "",
        created_at=iso(p.created_at), updated_at=iso(p.updated_at or p.created_at))


# ── Jobs ──────────────────────────────────────────────────────────────────────
class ProjectIn(BaseModel):
    name: str
    client: str = ""
    site: str = ""
    quote_no: str = ""
    kind: str = "doors"
    drawing_firm: str = ""


def _clip(s: str, n: int) -> str:
    return " ".join((s or "").split())[:n]


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    ps = db.query(models.Project).order_by(models.Project.id.desc()).all()
    return [project_out(p, db, full=False) for p in ps]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    name = _clip(payload.name, 120)
    if not name:
        raise HTTPException(400, "Give the job a name")
    if payload.kind not in ("doors", "symbols"):
        raise HTTPException(400, "A job reads doors from plans, or counts devices")
    p = models.Project(name=name, client=_clip(payload.client, 120), site=_clip(payload.site, 200),
                       quote_no=_clip(payload.quote_no, 40), kind=payload.kind,
                       drawing_firm=_clip(payload.drawing_firm, 120), owner_id=cu.id)
    db.add(p); db.commit(); db.refresh(p)
    clear_job_folders(p.id)          # a job number used before must not inherit that job's plans
    return project_out(p, db)


@router.get("/projects/{pid}", response_model=ProjectOut)
def get_project(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    return project_out(own_project(pid, db, cu), db)


@router.put("/projects/{pid}", response_model=ProjectOut)
def update_project(pid: int, payload: ProjectIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    p = edit_project(pid, db, cu)
    name = _clip(payload.name, 120)
    if not name:
        raise HTTPException(400, "Give the job a name")
    p.name, p.client, p.site, p.quote_no = name, _clip(payload.client, 120), _clip(payload.site, 200), _clip(payload.quote_no, 40)
    p.drawing_firm = _clip(payload.drawing_firm, 120)
    db.commit(); db.refresh(p)
    return project_out(p, db)


@router.post("/projects/{pid}/take", response_model=ProjectOut)
def take_job(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """I will check this one: the job is mine, and no one else works on it."""
    p = own_project(pid, db, cu)
    if p.owner_id and p.owner_id != cu.id:
        raise HTTPException(409, f"{p.owner.name if p.owner else 'Someone'} has already taken this job")
    p.owner_id = cu.id
    if p.stage in ("", "new"):
        p.stage = "taken" if p.source == "portal" else p.stage
    db.commit(); db.refresh(p)
    return project_out(p, db)


@router.post("/projects/{pid}/hand-back", response_model=ProjectOut)
def hand_back(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A portal job goes back to Incoming for someone else to take."""
    p = edit_project(pid, db, cu)
    if p.source != "portal":
        raise HTTPException(400, "Only a job sent in by an architect can be handed back")
    p.owner_id, p.stage, p.checked_at = None, "new", None
    db.commit(); db.refresh(p)
    return project_out(p, db)


class CheckedIn(BaseModel):
    done: bool = True


@router.post("/projects/{pid}/checked", response_model=ProjectOut)
def mark_checked(pid: int, payload: CheckedIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """Every door on the job has been looked over."""
    p = edit_project(pid, db, cu)
    if payload.done:
        p.owner_id = p.owner_id or cu.id
        p.stage, p.checked_at = "checked", utcnow()
    else:
        p.stage, p.checked_at = ("taken" if p.source == "portal" else ""), None
    db.commit(); db.refresh(p)
    return project_out(p, db)


@router.delete("/projects/{pid}", status_code=204)
def delete_project(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    _delete_job(db, edit_project(pid, db, cu))


def _delete_job(db: Session, p: models.Project):
    """The job and everything that is only its own: plans, drawings, doors, its own sets."""
    pid = p.id
    db.query(models.Invite).filter(models.Invite.project_id == pid).update({models.Invite.project_id: None})
    folders = [d.filename for d in p.drawings if d.filename]       # device counting drawings, on disk
    purge_project_rows(db, pid)
    db.expire(p)
    db.delete(p)
    db.commit()
    clear_job_folders(pid)
    for f in folders:
        if re.fullmatch(r"[a-f0-9]{32}", f):
            shutil.rmtree(Path("uploads") / f, ignore_errors=True)


CLEAN_START = "DELETE ALL JOBS"


class CleanStartIn(BaseModel):
    confirm: str = ""


@router.post("/projects/delete-all")
def delete_all_jobs(payload: CleanStartIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A clean start: every job goes, whoever made it. Products, the sets library and
    the architect links stay. Only with the words typed out, so it is never a slip."""
    if payload.confirm.strip().upper() != CLEAN_START:
        raise HTTPException(400, f"Type {CLEAN_START} to confirm")
    ids = [pid for (pid,) in db.query(models.Project.id).all()]
    gone = 0
    for pid in ids:
        p = db.query(models.Project).get(pid)
        if p:
            _delete_job(db, p)
            gone += 1
    import logging
    logging.getLogger(__name__).warning("Clean start: %s deleted all %d jobs", cu.email, gone)
    return {"deleted": gone}


def purge_project_rows(db: Session, pid: int):
    """Every row anywhere that belongs to the job, the old tools' tables included,
    so the job itself can go. Rows that only point back at it are let go of."""
    tables = [r[0] for r in db.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()]
    cols = {t: {r[1] for r in db.execute(text(f'PRAGMA table_info("{t}")')).fetchall()} for t in tables}
    if "drawings" in cols:
        ids = [r[0] for r in db.execute(text("SELECT id FROM drawings WHERE project_id=:p"), {"p": pid}).fetchall()]
        for did in ids:
            for t, cs in cols.items():
                if "drawing_id" in cs and t != "drawings":
                    if t == "drawing_pages":
                        db.execute(text(f'DELETE FROM "{t}" WHERE drawing_id=:d'), {"d": did})
                    else:
                        db.execute(text(f'UPDATE "{t}" SET drawing_id=NULL WHERE drawing_id=:d'), {"d": did})
    if "hardware_sets" in cols:
        # the job's own sets go with it: their products first, and anything copied from them lets go
        ids = [r[0] for r in db.execute(text("SELECT id FROM hardware_sets WHERE project_id=:p"), {"p": pid}).fetchall()]
        for sid in ids:
            if "set_items" in cols:
                db.execute(text("DELETE FROM set_items WHERE set_id=:s"), {"s": sid})
            db.execute(text("UPDATE hardware_sets SET copied_from_id=NULL WHERE copied_from_id=:s"), {"s": sid})
            if "project_sets" in cols:
                db.execute(text("DELETE FROM project_sets WHERE set_id=:s"), {"s": sid})
            if "doors" in cols:
                db.execute(text("UPDATE doors SET set_id=NULL WHERE set_id=:s"), {"s": sid})
            if "door_types" in cols:
                db.execute(text("UPDATE door_types SET set_id=NULL WHERE set_id=:s"), {"s": sid})
    for t, cs in cols.items():
        if "source_project_id" in cs:
            db.execute(text(f'UPDATE "{t}" SET source_project_id=NULL WHERE source_project_id=:p'), {"p": pid})
    # doors first: they point at door types and sets, which point at the job
    left = ["doors"] + [t for t, cs in cols.items() if "project_id" in cs and t not in ("projects", "doors", "invites")]
    for _ in range(4):
        stuck = []
        for t in left:
            if t not in cols:
                continue
            try:
                with db.begin_nested():
                    db.execute(text(f'DELETE FROM "{t}" WHERE project_id=:p'), {"p": pid})
            except Exception:
                stuck.append(t)
        if not stuck:
            return
        left = stuck


def clear_job_folders(pid: int):
    from plan_reads import ROOT
    shutil.rmtree(ROOT / str(pid), ignore_errors=True)
    shutil.rmtree(FILES_ROOT / str(pid), ignore_errors=True)


# ── The doors confirmed ───────────────────────────────────────────────────────
@router.get("/projects/{pid}/doors.xlsx")
def doors_excel(pid: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """The doors confirmed on the job, with their sets, as a spreadsheet to take into the CRM."""
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from schedule import _effective_set_id
    p = own_project(pid, db, cu)
    doors = db.query(models.Door).filter(models.Door.project_id == pid).all()
    sets = {s.id: s for s in db.query(models.HardwareSet).filter(
        models.HardwareSet.id.in_({sid for sid in (_effective_set_id(d) for d in doors) if sid})).all()}
    key = lambda d: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", d.ref or "")]
    doors.sort(key=lambda d: ((d.floor or "").lower(), key(d)))
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Doors"
    ws.append([p.name])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([" · ".join(x for x in (p.client, p.site) if x)])
    ws.append([f"{len(doors)} doors confirmed" + (f", checked by {p.owner.name}" if p.stage == "checked" and p.owner else "")])
    ws.append([])
    ws.append(["Door", "Floor", "Set", "Set name", "Note", "From"])
    head = ws.max_row
    for c in ws[head]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="00387B")
    for d in doors:
        s_ = sets.get(_effective_set_id(d))
        ws.append([d.ref, d.floor, s_.code if s_ else "", s_.name if s_ else "", d.note,
                   {"plans": "Floor plans", "schedule": "Door list"}.get(d.source or "", d.source or "")])
    for col, w in zip("ABCDEF", (18, 18, 10, 34, 50, 14)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = ws.cell(row=head + 1, column=1)
    buf = io.BytesIO()
    wb.save(buf)
    safe = re.sub(r"[^A-Za-z0-9 ._-]+", "", p.name).strip() or "job"
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe} doors.xlsx"'})


# ── What the architect sent, as sent ──────────────────────────────────────────
def _job_file(pid: int, i: int) -> tuple[dict, Path]:
    fs = job_files(pid)
    if not (0 <= i < len(fs)):
        raise HTTPException(404, "No such file")
    return fs[i], FILES_ROOT / str(pid) / fs[i]["file"]


@router.get("/projects/{pid}/files/{i}")
def get_job_file(pid: int, i: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    own_project(pid, db, cu)
    f, path = _job_file(pid, i)
    media = {"pdf": "application/pdf", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             "csv": "text/csv"}.get(f["kind"], "application/octet-stream")
    safe = re.sub(r'[^A-Za-z0-9 ._()-]+', "", f["name"]) or "file"
    return Response(path.read_bytes(), media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{safe}"', "X-Content-Type-Options": "nosniff"})


@router.post("/projects/{pid}/files/{i}/door-list")
def read_job_file_door_list(pid: int, i: int, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A door list the architect sent as a spreadsheet, read for the doors in it."""
    from detection.door_list import read_door_list
    from plan_reads import with_job
    edit_project(pid, db, cu)
    f, path = _job_file(pid, i)
    if f["kind"] not in ("xlsx", "csv"):
        raise HTTPException(400, "That file is not a spreadsheet")
    r = read_door_list(f["name"], path.read_bytes())
    r["name"] = f["name"]
    return with_job(db, pid, r)
