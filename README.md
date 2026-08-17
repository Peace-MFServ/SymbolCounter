# Symbol Counter — MF Services

A web application for detecting and verifying security/fire alarm symbols on engineering floor plan drawings.

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.10+ | [python.org](https://python.org) |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) — required for frontend build |
| Poppler | any | PDF rendering: `winget install poppler` (Windows) / `apt install poppler-utils` (Linux) |

---

## Quick Start (Windows)

Double-click **`start.bat`** from the `symbol-counter\` folder.

It will:
1. Check Python and Node.js are installed
2. Install Python dependencies (`pip install -r requirements.txt`)
3. Apply any pending database migrations (`alembic upgrade head`)
4. Install frontend dependencies (`npm install`) on first run
5. Build the frontend bundle (`npm run build`)
6. Start the backend at **http://localhost:8000**

Open **http://localhost:8000** in your browser.

---

## Manual Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
alembic upgrade head          # create / migrate database
uvicorn main:app --port 8000
```

### 2. Frontend (development mode with hot-reload)

```bash
cd frontend
npm install
npm run dev                   # dev server at http://localhost:5173
```

### 2b. Frontend (production build — served by FastAPI)

```bash
cd frontend
npm install
npm run build                 # outputs to frontend/dist/
```

FastAPI serves `frontend/dist/` at the root URL when running in production mode.

---

## First Use

1. Open the app and click **Register** to create your account
2. Create a **New Project** — enter client name, site address, and drawing firm
3. Drag PDF floor plan drawings onto the project
4. Detection runs automatically in the background
5. Click **Review →** on any drawing to open the verification canvas
6. Zoom, place, correct, and delete markers — then **Save Page**
7. Export verified counts as Excel or JSON from the project view

---

## Verification Canvas

| Action | How |
|---|---|
| Place marker | Click empty area (uses active type) |
| Select marker | Click on it |
| Correct / remove marker | Right-click → context menu |
| Change active type | Click type in sidebar, or press `1`–`9` |
| Snip template | Click ✂ next to a type, drag box around example |
| Bulk remove type | Bulk Actions panel → ✕ |
| Save page | `Ctrl+S` or 💾 button |
| Zoom | Scroll |
| Pan | `Space` + drag |
| Remove selected | `Del` / `Backspace` |
| Deselect | `Esc` |

---

## Project Structure

```
symbol-counter/
├── start.bat                   ← double-click to run
├── README.md
│
├── backend/
│   ├── main.py                 # FastAPI — all API routes
│   ├── models.py               # SQLAlchemy models
│   ├── database.py             # Engine + WAL + FK pragmas
│   ├── auth.py                 # JWT authentication
│   ├── alembic.ini             # Alembic configuration
│   ├── alembic/
│   │   ├── env.py
│   │   └── versions/
│   │       ├── 0001_initial_schema.py
│   │       └── 0002_drawing_approval_fields.py
│   ├── detection/
│   │   └── pipeline.py         # PDF render + OpenCV detection engine
│   ├── backup.py               # Nightly backup script
│   ├── requirements.txt
│   ├── uploads/                # PDFs + rendered pages (auto-created)
│   ├── backups/                # DB backups (auto-created by backup.py)
│   └── symbol_counter.db       # SQLite database (auto-created)
│
└── frontend/
    ├── index.html              # Vite entry point
    ├── vite.config.js
    ├── package.json
    └── src/
        ├── main.jsx            # ReactDOM entry
        ├── App.jsx             # Router
        ├── index.css           # Global styles
        ├── api.js              # Fetch helper + auth interceptor
        ├── toast.js            # Toast notifications
        ├── auth.jsx            # AuthProvider + Login/Register pages
        ├── Dashboard.jsx       # Project list
        ├── ProjectView.jsx     # Drawing list + upload + export
        ├── SymbolManager.jsx   # Configure symbol types
        └── VerifyView.jsx      # Canvas verification tool
```

---

## Nightly Backup

Run manually or schedule via Windows Task Scheduler:

```bat
cd backend
python backup.py
```

Options:
- `--keep N`    — keep N most recent backups (default: 14)
- `--dest PATH` — backup directory (default: `backend\backups\`)
- `--db PATH`   — path to database file

Backups are integrity-checked automatically. If the check fails the backup file is deleted and the script exits non-zero.

**Scheduling on Windows** (Task Scheduler):
1. Action → New Task
2. Trigger: Daily, 02:00
3. Action: `python C:\path\to\symbol-counter\backend\backup.py`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | (insecure default) | JWT signing key — **set this in production** |
| `DATABASE_URL` | `sqlite:///./symbol_counter.db` | Change to `postgresql://...` for production |

---

## API Reference

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login → JWT |
| GET  | `/api/auth/me` | Current user |
| GET  | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| DELETE | `/api/projects/{id}` | Delete project |
| GET  | `/api/projects/{id}/symbol-types` | List symbol types |
| POST | `/api/projects/{id}/symbol-types` | Add symbol type |
| GET  | `/api/projects/{id}/drawings` | List drawings |
| POST | `/api/projects/{id}/drawings` | Upload PDF |
| GET  | `/api/projects/{id}/drawings/processing-count` | Live detection count |
| GET  | `/api/drawings/{id}/pages` | Pages + detections |
| PUT  | `/api/drawings/{id}/detections` | Save verified detections |
| POST | `/api/drawings/{id}/approve` | Approve drawing |
| PATCH | `/api/drawings/{id}/door-refs` | Correct door references |
| POST | `/api/drawings/{id}/crop-template` | Snip a new template |
| GET  | `/api/projects/{id}/compare` | Revision spatial diff |
| GET  | `/api/projects/{id}/export/excel` | Excel summary |
| GET  | `/api/projects/{id}/export/json` | JSON scheduling export |
| GET  | `/api/files/pages/{path}` | Authenticated page image |
| GET  | `/api/files/templates/{filename}` | Authenticated template image |
