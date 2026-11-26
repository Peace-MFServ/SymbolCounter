"""
MF Services door reader: architects send their floor plans in through a locked
portal, the doors are read off the plans, and the team checks them and gives
them their sets.

  /api/auth/...       the team's logins
  /api/projects/...   jobs, their plans as read, the doors confirmed     (jobs.py, plan_reads.py)
  /api/invites/...    links and PINs for architects                      (portal.py)
  /api/portal/...     the only part an architect can reach, with a PIN   (portal.py)
  /api/products, /api/sets, /api/cin7/...   products, the Cin7 sync, the sets library  (schedule.py, documents.py)
  /api/drawings, /api/templates ...          device counting            (symbols.py)
"""
import logging
import logging.handlers
import os
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

import auth
import models
from database import engine, get_db, Base

logger = logging.getLogger(__name__)

# Relative paths (uploads/) are from this folder, wherever uvicorn was started.
os.chdir(Path(__file__).resolve().parent)

_LOG_DIR = Path(__file__).resolve().parent / "logs"
_LOG_DIR.mkdir(exist_ok=True)
_file_handler = logging.handlers.RotatingFileHandler(str(_LOG_DIR / "app.log"), maxBytes=5 * 1024 * 1024,
                                                     backupCount=3, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-8s %(name)s — %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
_file_handler.setLevel(logging.INFO)
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
_console_handler.setLevel(logging.INFO)
logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])

Base.metadata.create_all(bind=engine)


def _ensure_columns():
    """New columns on tables made before they existed (safe on every start)."""
    import sqlalchemy as sa
    adds = {
        "projects": {"kind": "TEXT DEFAULT 'symbols'", "notes": "TEXT DEFAULT ''", "quote_no": "TEXT DEFAULT ''",
                     "rep": "TEXT DEFAULT ''", "revision": "INTEGER DEFAULT 1", "sets_only": "BOOLEAN DEFAULT 0",
                     "source": "TEXT DEFAULT ''", "stage": "TEXT DEFAULT ''",
                     "brief": "TEXT DEFAULT ''", "contact": "TEXT DEFAULT ''", "received_at": "DATETIME",
                     "due_at": "DATETIME", "checked_at": "DATETIME"},
        "doors": {"excluded": "BOOLEAN DEFAULT 0", "excluded_reason": "TEXT DEFAULT ''", "side": "TEXT DEFAULT ''"},
        "global_templates": {"threshold_override": "REAL"},
        "drawings": {"error_message": "TEXT"},
        "products": {"product_type": "TEXT DEFAULT ''", "brand": "TEXT DEFAULT ''"},
        "documents": {"codes": "TEXT DEFAULT ''", "has_text": "BOOLEAN"},
        "product_documents": {"confirmed": "BOOLEAN DEFAULT 0"},
        "hardware_sets": {"project_id": "INTEGER", "locked_by_id": "INTEGER", "locked_at": "DATETIME"},
    }
    try:
        with engine.begin() as conn:
            for table, cols in adds.items():
                have = {row[1] for row in conn.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()}
                for name, ddl in cols.items():
                    if have and name not in have:
                        conn.execute(sa.text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                        logger.info("Migrated: added %s.%s", table, name)
    except Exception as exc:
        logger.error("Column migration failed: %s", exc)


_ensure_columns()
Path("uploads").mkdir(exist_ok=True)

app = FastAPI(title="MF door reader", version="4.0.0", docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://localhost:5173", "http://127.0.0.1:8000", "http://127.0.0.1:5173"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# What the browser is told about every page and file: never framed by another site, never
# told where it came from (the link to the portal carries its key), never guessing file types.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": ("default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
                                "font-src 'self' data:; script-src 'self'; connect-src 'self'; object-src 'none'; "
                                "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
}


@app.middleware("http")
async def guard(request: Request, call_next):
    # an architect's upload is refused by its size before it is taken in, not after
    from portal import MAX_FILE_BYTES
    if request.url.path.startswith("/api/portal/") and request.method == "POST":
        try:
            n = int(request.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n > MAX_FILE_BYTES + 1024 * 1024:
            return JSONResponse({"detail": "That file is too big. The largest a file can be is "
                                 f"{MAX_FILE_BYTES // (1024 * 1024)} MB."}, status_code=413)
    response = await call_next(request)
    for k, v in _SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


_HERE = Path(__file__).resolve().parent
FRONTEND_DIST = _HERE.parent / "frontend" / "dist"
from fastapi.staticfiles import StaticFiles as _SF  # noqa: E402
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", _SF(directory=str(FRONTEND_DIST / "assets")), name="assets")


# ── The team's logins ─────────────────────────────────────────────────────────
class UserCreate(BaseModel):
    email: EmailStr
    name: str
    password: str
    code: str = ""


# When set (the server), new accounts need this word. Empty = open sign-up (a PC in the office).
REGISTER_CODE = os.getenv("REGISTER_CODE", "").strip()


class UserOut(BaseModel):
    id: int
    email: str
    name: str

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


@app.post("/api/auth/register", response_model=Token, status_code=201)
def register(payload: UserCreate, request: Request, db: Session = Depends(get_db)):
    from portal import throttle
    throttle(request, "register", 10, 3600)
    if REGISTER_CODE and payload.code.strip() != REGISTER_CODE:
        raise HTTPException(403, "Invite code needed. Ask Peace for it." if not payload.code.strip() else "That invite code is not right.")
    if len(payload.password) < 8:
        raise HTTPException(400, "Use a password of at least 8 characters")
    if db.query(models.User).filter(models.User.email == payload.email).first():
        raise HTTPException(400, "Email already registered")
    user = models.User(email=payload.email, name=" ".join(payload.name.split())[:80] or payload.email,
                       hashed_password=auth.hash_password(payload.password))
    db.add(user); db.commit(); db.refresh(user)
    return {"access_token": auth.create_access_token({"sub": user.email}), "token_type": "bearer", "user": user}


@app.post("/api/auth/login", response_model=Token)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    from portal import throttle
    throttle(request, "login", 30, 900)
    user = db.query(models.User).filter(models.User.email == form.username).first()
    if not user or not auth.verify_password(form.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    return {"access_token": auth.create_access_token({"sub": user.email}), "token_type": "bearer", "user": user}


@app.get("/api/auth/me", response_model=UserOut)
def me(current_user=Depends(auth.get_current_user)):
    return current_user


from jobs import router as jobs_router  # noqa: E402
from plan_reads import router as plan_reads_router  # noqa: E402
from portal import router as portal_router, staff as invites_router  # noqa: E402
from schedule import router as schedule_router  # noqa: E402
from documents import router as documents_router  # noqa: E402
from symbols import router as symbols_router  # noqa: E402
app.include_router(jobs_router)
app.include_router(plan_reads_router)
app.include_router(invites_router)
app.include_router(portal_router)
app.include_router(schedule_router)
app.include_router(documents_router)
app.include_router(symbols_router)


# One-off: pictures stored before the normaliser existed get tidied at startup.
@app.on_event("startup")
def _tidy_product_pictures():
    import threading

    def run():
        from database import SessionLocal
        from images import normalize_all
        from schedule import PRODUCT_IMG_DIR
        db = SessionLocal()
        try:
            n = normalize_all(db, models.Product, PRODUCT_IMG_DIR)
            if n:
                logger.info("Normalised %d product pictures", n)
        except Exception as e:
            logger.warning("Picture tidy skipped: %s", e)
        finally:
            db.close()
    threading.Thread(target=run, daemon=True).start()


@app.on_event("startup")
def _cin7_nightly():
    """Once the office has applied a Cin7 sync by hand, keep it fresh every
    night at three. Nothing runs until that first deliberate sync."""
    import threading
    import time
    from datetime import datetime, timezone

    def run():
        import cin7
        from database import SessionLocal
        from schedule import _data_dir, guess_product_type
        done_for = ""
        while True:
            time.sleep(15 * 60)
            try:
                now = datetime.now(timezone.utc)
                today = now.strftime("%Y-%m-%d")
                if not cin7.configured() or now.hour != 3 or done_for == today:
                    continue
                last = cin7.last_run(_data_dir())
                if not last or not last.get("applied"):
                    continue
                db = SessionLocal()
                try:
                    report = cin7.sync(db, models, guess_product_type, apply=True)
                    report["by"] = "nightly refresh"
                    cin7.remember(_data_dir(), report)
                    logger.info("Cin7 nightly: %d new, %d updated", report["new"], report["changed"])
                finally:
                    db.close()
                done_for = today
            except Exception as e:
                logger.warning("Cin7 nightly skipped: %s", e)
                done_for = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    threading.Thread(target=run, daemon=True).start()


@app.get("/api/health")
def health():
    from symbols import POPPLER_OK
    return {"status": "ok" if POPPLER_OK else "degraded", "version": "4.1.0", "poppler": POPPLER_OK}


# ── The page itself ───────────────────────────────────────────────────────────
@app.get("/")
@app.get("/{full_path:path}")
async def serve_frontend(full_path: str = ""):
    if full_path.startswith(("api/", "src/")):
        raise HTTPException(status_code=404)
    if full_path:
        candidate = (FRONTEND_DIST / full_path).resolve()
        if FRONTEND_DIST.resolve() in candidate.parents and candidate.is_file():
            return FileResponse(str(candidate))
    index = FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(str(index), headers={"Cache-Control": "no-cache"})
    return {"message": "The page is not built yet: cd frontend && npm run build"}
