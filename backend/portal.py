"""
The architect's way in: a link and a PIN, for one project.

What a stranger can do with this, and nothing more:
  - with a link that is not one of ours: be told the link is not valid
  - with a link but not its PIN: try PINs, five wrong and the link locks
  - with the link and the PIN: send that one project's plans in, once

The link's key sits after the # (portal#key), so it is never sent to the server
in the page address, never written to a log and never passed on to another site.
Every PIN is twelve characters and kept only as a hash. Each address is also
held back after a run of wrong PINs on any link. Files are taken only as PDF or
spreadsheet, by what is in them and not by their name, and each is opened in a
process of its own with a time limit, so a broken or hostile file cannot take
the server down with it.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

import auth
import models
from database import get_db
from jobs import FILES_ROOT, TURNAROUND_HOURS, clear_job_folders, iso, utcnow

router = APIRouter(prefix="/api/portal", tags=["portal"])
staff = APIRouter(prefix="/api/invites", tags=["invites"], dependencies=[Depends(auth.get_current_user)])

INTAKE = Path("uploads") / "intake"
MAX_FILE_BYTES = 200 * 1024 * 1024        # one file
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024  # everything sent for one project
MAX_FILES = 40
MAX_WRONG = 5                              # wrong PINs before the link locks
SESSION_HOURS = 3
PIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: nothing to misread
KINDS = {".pdf": "pdf", ".xlsx": "xlsx", ".xlsm": "xlsx", ".csv": "csv"}


# ── Holding back an address that keeps trying ─────────────────────────────────
_hits: dict = defaultdict(deque)
_hits_lock = threading.Lock()


def _ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _count(request: Request, bucket: str, secs: int, add: bool) -> int:
    key, now = (bucket, _ip(request)), time.monotonic()
    with _hits_lock:
        q = _hits[key]
        while q and now - q[0] > secs:
            q.popleft()
        if add:
            q.append(now)
        if len(_hits) > 50000:                 # never let the record itself grow without end
            for k in [k for k, v in _hits.items() if not v][:25000]:
                _hits.pop(k, None)
        return len(q)


def throttle(request: Request, bucket: str, limit: int, secs: int):
    """Every call counts; past the limit the address waits."""
    if _count(request, bucket, secs, add=True) > limit:
        raise HTTPException(429, "Too many tries. Wait a while and try again.")


# ── Links and PINs ────────────────────────────────────────────────────────────
def _new_pin() -> str:
    raw = "".join(secrets.choice(PIN_ALPHABET) for _ in range(12))
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"


def _pin_norm(pin: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (pin or "").upper())


def _state(inv: models.Invite) -> str:
    if inv.status == "sent":
        return "sent"
    if inv.status == "closed":
        return "closed"
    if inv.locked:
        return "locked"
    if inv.expires_at and inv.expires_at.replace(tzinfo=None) < utcnow():
        return "expired"
    return "open"


_SAY = {
    "sent": "The plans for this project have been sent to MF Services. Thank you.",
    "closed": "This link has been closed. Contact MF Services if you need to send plans.",
    "locked": "This link is locked after too many wrong PINs. Contact MF Services to unlock it.",
    "expired": "This link has expired. Contact MF Services for a new one.",
}


def _by_token(db: Session, token: str) -> models.Invite:
    token = (token or "").strip()
    inv = None
    if re.fullmatch(r"[A-Za-z0-9_-]{30,80}", token):
        inv = db.query(models.Invite).filter(models.Invite.token == token).first()
    if not inv or not secrets.compare_digest(inv.token, token):
        raise HTTPException(404, "This link is not valid. Check it was copied in full, or contact MF Services.")
    return inv


# ── The team: making and minding the links ───────────────────────────────────
class InviteIn(BaseModel):
    firm: str = ""
    email: str = ""
    project: str = ""
    days: int = 14


def _invite_out(inv: models.Invite) -> dict:
    return {"id": inv.id, "token": inv.token, "firm": inv.firm or "", "email": inv.email or "",
            "project": inv.project_hint or "", "state": _state(inv), "failed": inv.failed or 0,
            "created_by": inv.created_by.name if inv.created_by else "", "created_at": iso(inv.created_at),
            "expires_at": iso(inv.expires_at), "sent_at": iso(inv.sent_at), "project_id": inv.project_id}


def _clip(s: str, n: int) -> str:
    return " ".join((s or "").split())[:n]


@staff.get("")
def list_invites(db: Session = Depends(get_db)):
    return [_invite_out(i) for i in db.query(models.Invite).order_by(models.Invite.id.desc()).limit(500).all()]


@staff.post("", status_code=201)
def make_invite(payload: InviteIn, db: Session = Depends(get_db), cu=Depends(auth.get_current_user)):
    """A new link and PIN. The PIN is shown this once; it is kept only as a hash."""
    if not _clip(payload.firm, 120):
        raise HTTPException(400, "Say which architect the link is for")
    pin = _new_pin()
    inv = models.Invite(token=secrets.token_urlsafe(32), pin_hash=auth.hash_password(_pin_norm(pin)),
                        firm=_clip(payload.firm, 120), email=_clip(payload.email, 160), project_hint=_clip(payload.project, 160),
                        created_by_id=cu.id, expires_at=utcnow() + timedelta(days=max(1, min(int(payload.days or 14), 60))))
    db.add(inv); db.commit(); db.refresh(inv)
    return {"invite": _invite_out(inv), "pin": pin}


def _get(db: Session, iid: int) -> models.Invite:
    inv = db.query(models.Invite).get(iid)
    if not inv:
        raise HTTPException(404, "No such link")
    return inv


@staff.post("/{iid}/new-pin")
def new_pin(iid: int, db: Session = Depends(get_db)):
    """A fresh PIN: the old one stops working, anyone part way in is sent back to the PIN, and the link unlocks."""
    inv = _get(db, iid)
    if inv.status == "sent":
        raise HTTPException(400, "The plans have already been sent on this link")
    pin = _new_pin()
    inv.pin_hash, inv.failed, inv.locked = auth.hash_password(_pin_norm(pin)), 0, False
    inv.session_ver = (inv.session_ver or 1) + 1
    db.commit(); db.refresh(inv)
    return {"invite": _invite_out(inv), "pin": pin}


@staff.post("/{iid}/unlock")
def unlock(iid: int, db: Session = Depends(get_db)):
    inv = _get(db, iid)
    inv.failed, inv.locked = 0, False
    db.commit(); db.refresh(inv)
    return _invite_out(inv)


class DaysIn(BaseModel):
    days: int = 14


@staff.post("/{iid}/extend")
def extend(iid: int, payload: DaysIn, db: Session = Depends(get_db)):
    inv = _get(db, iid)
    if inv.status == "sent":
        raise HTTPException(400, "The plans have already been sent on this link")
    inv.expires_at = utcnow() + timedelta(days=max(1, min(int(payload.days or 14), 60)))
    inv.status = "open"
    db.commit(); db.refresh(inv)
    return _invite_out(inv)


@staff.post("/{iid}/close")
def close(iid: int, db: Session = Depends(get_db)):
    inv = _get(db, iid)
    if inv.status != "sent":
        inv.status = "closed"
        inv.session_ver = (inv.session_ver or 1) + 1
    db.commit(); db.refresh(inv)
    return _invite_out(inv)


@staff.delete("/{iid}", status_code=204)
def delete_invite(iid: int, db: Session = Depends(get_db)):
    """The link goes, and any files sent on it that never reached a job. A job made from it stays."""
    inv = _get(db, iid)
    db.delete(inv); db.commit()
    shutil.rmtree(INTAKE / str(iid), ignore_errors=True)


# ── The architect: in with the PIN ────────────────────────────────────────────
class OpenIn(BaseModel):
    token: str


class UnlockIn(BaseModel):
    token: str
    pin: str


@router.post("/open")
def open_link(payload: OpenIn, request: Request, db: Session = Depends(get_db)):
    """Is this link good? Nothing about the project is told until the PIN is given."""
    throttle(request, "open", 60, 600)
    inv = _by_token(db, payload.token)
    st = _state(inv)
    return {"state": st, "message": _SAY.get(st, "")}


@router.post("/unlock")
def unlock_link(payload: UnlockIn, request: Request, db: Session = Depends(get_db)):
    throttle(request, "open", 60, 600)
    if _count(request, "pin", 3600, add=False) >= 10:
        raise HTTPException(429, "Too many wrong PINs from here. Wait an hour and try again.")
    inv = _by_token(db, payload.token)
    st = _state(inv)
    if st != "open":
        raise HTTPException(403, _SAY[st])
    if not auth.verify_password(_pin_norm(payload.pin)[:24], inv.pin_hash):
        _count(request, "pin", 3600, add=True)
        inv.failed = (inv.failed or 0) + 1
        if inv.failed >= MAX_WRONG:
            inv.locked = True
        db.commit()
        if inv.locked:
            raise HTTPException(403, _SAY["locked"])
        left = MAX_WRONG - inv.failed
        raise HTTPException(401, f"That PIN is not right. {left} {'try' if left == 1 else 'tries'} left before the link locks.")
    inv.failed = 0
    db.commit()
    session = jwt.encode({"typ": "portal", "inv": inv.id, "v": inv.session_ver or 1,
                          "exp": utcnow() + timedelta(hours=SESSION_HOURS)}, auth.SECRET_KEY, algorithm=auth.ALGORITHM)
    return {"session": session, **_me(inv)}


def portal_invite(x_portal_session: str = Header(default=""), db: Session = Depends(get_db)) -> models.Invite:
    """The link an architect has opened with its PIN, still open."""
    try:
        claims = jwt.decode(x_portal_session, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])
    except JWTError:
        raise HTTPException(401, "Your session has ended. Enter the PIN again.")
    if claims.get("typ") != "portal" or not isinstance(claims.get("inv"), int):
        raise HTTPException(401, "Your session has ended. Enter the PIN again.")
    inv = db.query(models.Invite).get(claims["inv"])
    if not inv or claims.get("v") != (inv.session_ver or 1):
        raise HTTPException(401, "Your session has ended. Enter the PIN again.")
    st = _state(inv)
    if st != "open":
        raise HTTPException(403, _SAY[st])
    return inv


# ── Files sent in ─────────────────────────────────────────────────────────────
_files_lock = threading.Lock()


def _list(iid: int) -> list[dict]:
    f = INTAKE / str(iid) / "files.json"
    try:
        return json.loads(f.read_text()) if f.exists() else []
    except (ValueError, OSError):
        return []


def _save_list(iid: int, files: list[dict]):
    d = INTAKE / str(iid)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "files.json.tmp"
    tmp.write_text(json.dumps(files))
    tmp.replace(d / "files.json")


def _me(inv: models.Invite) -> dict:
    return {"firm": inv.firm or "", "project": inv.project_hint or "", "email": inv.email or "",
            "files": [_file_out(f) for f in _list(inv.id)], "turnaround_hours": TURNAROUND_HOURS,
            "limits": {"file_mb": MAX_FILE_BYTES // (1024 * 1024), "files": MAX_FILES}}


def _file_out(f: dict) -> dict:
    return {k: f.get(k) for k in ("id", "name", "size", "kind", "pages", "unreadable", "note")}


@router.get("/me")
def me(inv: models.Invite = Depends(portal_invite)):
    return _me(inv)


# Opened in a separate Python, isolated (-I) from this folder, with a time and
# memory limit: what it says about the file is all that comes back.
_CHECK = r"""
import json, sys
path, kind = sys.argv[1], sys.argv[2]
try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (3 * 1024 ** 3, 3 * 1024 ** 3))
except Exception:
    pass
out = {}
if kind == "pdf":
    import pymupdf
    try:
        doc = pymupdf.open(path, filetype="pdf")
    except Exception:
        print(json.dumps({"bad": "This PDF could not be opened. It may be damaged; export it again and upload that."})); sys.exit()
    if doc.needs_pass or doc.is_encrypted:
        print(json.dumps({"bad": "This PDF is password protected. Please upload it without the password."})); sys.exit()
    n = doc.page_count
    if n == 0:
        print(json.dumps({"bad": "This PDF has no pages."})); sys.exit()
    unreadable = [i + 1 for i in range(min(n, 400)) if len(doc[i].get_text("words")) < 25]
    out = {"pages": n, "unreadable": unreadable}
else:
    try:
        if kind == "xlsx":
            import openpyxl
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
            out = {"pages": len(wb.sheetnames)}
        else:
            if b"\x00" in open(path, "rb").read(2_000_000):
                raise ValueError
            out = {"pages": 1}
    except Exception:
        print(json.dumps({"bad": "This spreadsheet could not be opened. Save it as .xlsx or .csv and upload that."})); sys.exit()
print(json.dumps(out))
"""


def _check(path: Path, kind: str) -> dict:
    try:
        r = subprocess.run([sys.executable, "-I", "-c", _CHECK, str(path.resolve()), kind],
                           capture_output=True, text=True, timeout=120, cwd="/" if os.name != "nt" else None)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except subprocess.TimeoutExpired:
        return {"bad": "This file took too long to open. Export it again, or split it into smaller files."}
    except (ValueError, IndexError):
        return {"bad": "This file could not be opened. Export it again and upload that."}


def _kind_of(name: str, head: bytes) -> Optional[str]:
    """What the file really is, by its first bytes, and only then by its name."""
    ext = Path(name).suffix.lower()
    kind = KINDS.get(ext)
    if kind == "pdf" and head.startswith(b"%PDF"):
        return "pdf"
    if kind == "xlsx" and head.startswith(b"PK\x03\x04"):
        return "xlsx"
    if kind == "csv" and b"\x00" not in head and not head.startswith((b"%PDF", b"PK\x03\x04", b"MZ", b"\x7fELF")):
        return "csv"
    return None


def _safe_name(name: str) -> str:
    name = Path((name or "").replace("\\", "/")).name
    name = re.sub(r"[^\w .()+&,-]+", "_", name, flags=re.UNICODE).strip(" .") or "file"
    return name[:150]


@router.post("/files")
async def send_file(request: Request, file: UploadFile = File(...), inv: models.Invite = Depends(portal_invite)):
    """One file at a time: kept if it is a PDF or a spreadsheet, and checked straight away."""
    throttle(request, "upload", 300, 3600)
    have = _list(inv.id)
    if len(have) >= MAX_FILES:
        raise HTTPException(400, f"That is the most files that can be sent ({MAX_FILES}). Combine some into one PDF.")
    name = _safe_name(file.filename)
    head = await file.read(8)
    kind = _kind_of(name, head)
    if not kind:
        raise HTTPException(400, f"{name}: only PDF floor plans and Excel (.xlsx) or .csv door lists can be sent.")
    d = INTAKE / str(inv.id)
    d.mkdir(parents=True, exist_ok=True)
    fid = secrets.token_hex(6)
    dest = d / f"{fid}.{ 'pdf' if kind == 'pdf' else kind }"
    total = sum(f.get("size", 0) for f in have)
    size = len(head)
    try:
        with open(dest, "wb") as out:
            out.write(head)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(413, f"{name} is too big. The largest a file can be is {MAX_FILE_BYTES // (1024 * 1024)} MB.")
                if total + size > MAX_TOTAL_BYTES:
                    raise HTTPException(413, "That is more than can be sent for one project. Contact MF Services.")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    seen = await run_in_threadpool(_check, dest, kind)
    if seen.get("bad"):
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"{name}: {seen['bad']}")
    unreadable = seen.get("unreadable") or []
    pages = seen.get("pages") or 0
    note = ""
    if kind == "pdf" and unreadable:
        which = "All its sheets" if len(unreadable) == pages else (
            f"Sheet {unreadable[0]}" if len(unreadable) == 1 else f"Sheets {', '.join(map(str, unreadable[:8]))}{'...' if len(unreadable) > 8 else ''}")
        note = (f"{which} {'has' if len(unreadable) == 1 and pages > 1 else 'have'} no text to read: "
                f"{'it looks' if len(unreadable) == 1 and pages > 1 else 'they look'} like a scan or a picture. "
                "If these are floor plans, please upload the PDF exported from CAD.")
    entry = {"id": fid, "name": name, "file": dest.name, "size": size, "kind": kind, "pages": pages,
             "unreadable": unreadable, "note": note}
    with _files_lock:
        files = _list(inv.id)
        files.append(entry)
        _save_list(inv.id, files)
    return _file_out(entry)


@router.delete("/files/{fid}")
def remove_file(fid: str, inv: models.Invite = Depends(portal_invite)):
    with _files_lock:
        files = _list(inv.id)
        gone = [f for f in files if f["id"] == fid]
        if not gone:
            raise HTTPException(404, "No such file")
        (INTAKE / str(inv.id) / gone[0]["file"]).unlink(missing_ok=True)
        _save_list(inv.id, [f for f in files if f["id"] != fid])
    return {"files": [_file_out(f) for f in _list(inv.id)]}


# ── Sending it all ────────────────────────────────────────────────────────────
class SendIn(BaseModel):
    company: str
    name: str
    email: EmailStr
    phone: str
    project: str
    site: str
    brief: str
    agree: bool = False


BRIEF_MIN = 40


@router.post("/send")
def send(payload: SendIn, request: Request, db: Session = Depends(get_db), inv: models.Invite = Depends(portal_invite)):
    """Everything in: the job is made, its plans are read, and the team sees it in Incoming."""
    throttle(request, "send", 20, 3600)
    need = {"company": "your company", "name": "your name", "phone": "a phone number", "project": "the project name",
            "site": "the site address"}
    for k, what in need.items():
        if not _clip(getattr(payload, k), 200):
            raise HTTPException(400, f"Fill in {what}")
    if not re.fullmatch(r"[\d +()./-]{6,30}", payload.phone.strip()):
        raise HTTPException(400, "Check the phone number")
    brief = (payload.brief or "").strip()
    if len(brief) < BRIEF_MIN:
        raise HTTPException(400, f"Tell us a little more about the project in the brief (at least {BRIEF_MIN} characters)")
    if not payload.agree:
        raise HTTPException(400, f"Tick to confirm the plans are as the {TURNAROUND_HOURS} hour terms ask")
    files = _list(inv.id)
    pdfs = [f for f in files if f["kind"] == "pdf"]
    if not pdfs:
        raise HTTPException(400, "Upload the floor plans as PDF")
    if all(len(f.get("unreadable") or []) == f.get("pages") for f in pdfs):
        raise HTTPException(400, "None of the PDFs has text that can be read: they look like scans. Upload the PDFs exported from CAD.")

    now = utcnow()
    contact = {"company": _clip(payload.company, 120), "name": _clip(payload.name, 120), "email": str(payload.email)[:160],
               "phone": _clip(payload.phone, 30), "invited_as": inv.firm or ""}
    p = models.Project(name=_clip(payload.project, 120), client=contact["company"], site=_clip(payload.site, 200),
                       kind="doors", source="portal", stage="new", brief=brief[:8000], contact=json.dumps(contact),
                       received_at=now, due_at=now + timedelta(hours=TURNAROUND_HOURS), owner_id=None)
    db.add(p); db.flush()
    pid = p.id
    clear_job_folders(pid)
    # every file as it was sent, for the team to open
    keep = FILES_ROOT / str(pid)
    keep.mkdir(parents=True, exist_ok=True)
    index = []
    for i, f in enumerate(files):
        src = INTAKE / str(inv.id) / f["file"]
        if not src.exists():
            continue
        dest = f"{i}.{f['kind']}"
        shutil.copyfile(src, keep / dest)
        index.append({"name": f["name"], "file": dest, "size": f["size"], "kind": f["kind"], "pages": f.get("pages"),
                      "unreadable": f.get("unreadable") or []})
    (keep / "index.json").write_text(json.dumps(index))
    inv.status, inv.sent_at, inv.project_id = "sent", now, pid
    db.commit()
    shutil.rmtree(INTAKE / str(inv.id), ignore_errors=True)

    # the plans are read now, so the draft is waiting when someone opens the job
    from plan_reads import new_reading, read_now
    plans = [(f["name"], (keep / f["file"]).read_bytes()) for f in index if f["kind"] == "pdf"]
    rid, _, _ = new_reading(pid, plans, None)

    def work():
        try:
            read_now(pid, rid)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Reading the plans of job %s failed", pid)
    threading.Thread(target=work, daemon=True).start()
    return {"ref": f"MF-{pid:05d}", "turnaround_hours": TURNAROUND_HOURS}
