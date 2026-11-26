# MF Services Door Reader

Architects send their floor plans in through a locked portal; the doors are read
off the plans; the team checks them. A playground for Liam, Norman, Evan and
Peace to test until the reader finds 99% of doors and flags the rest, before it
moves into the CRM. Door schedules and sets live in the CRM, not here.

## How it works

1. **Architect links** (staff): make a link for an architect. It comes with a
   12-character PIN, shown once. Send the link by email and the PIN separately.
2. **The portal** (`/portal#key`, the architect): enter the PIN, fill in their
   details and the project's, upload the floor plans (PDF from CAD) and any door
   list (.xlsx/.csv), write a brief, tick the terms, send. Each file is checked as
   it arrives; a scan is flagged there and then.
3. **Incoming** (staff): the job appears with the clock running (48 hours by
   default). Someone takes it, checks the doors on the plan reader page,
   confirms them, and marks the job checked. The confirmed doors download as Excel.

Jobs can also be made by hand from plans already in hand.

## What a stranger can do

- Without a link: nothing. Every team page and file needs a login.
- With a made-up link: be told it is not valid.
- With a real link but not the PIN: try PINs. Five wrong in a row locks the link
  until someone on the team unlocks it or makes a new PIN. Ten wrong PINs from one
  address, on any links, holds that address back for an hour.
- With the link and the PIN: send that one project's plans, once.

The key in the link sits after the `#`, so it is never sent in a page address,
never logged, and never passed to another site. PINs are kept only as hashes.
Uploads are taken only if they really are PDFs or spreadsheets (by their content,
not their name), up to 200 MB each, and each is opened in a separate process with
time and memory limits. Pages carry a strict content security policy and cannot
be framed by another site.

## Code

| | |
|---|---|
| `backend/main.py` | app setup, logins, security headers |
| `backend/jobs.py` | jobs, Incoming, take / checked, doors as Excel, files as sent |
| `backend/plan_reads.py` | a job's plans as read, confirming doors |
| `backend/portal.py` | architect links and PINs, the portal |
| `backend/detection/plan_reader.py` | reading door tags off any architect's plans |
| `backend/detection/door_list.py` | reading a door list spreadsheet |
| `frontend/src/Dashboard.jsx` | Jobs and Incoming |
| `frontend/src/InvitesView.jsx` | Architect links |
| `frontend/src/PlanReaderView.jsx` | the plan beside the doors read off it |
| `frontend/src/Portal.jsx` | the architect's page |

## Run it

On the server: see `DEPLOY.md` (`git pull && docker compose up -d --build`).

On a PC:

```
cd backend && pip install -r requirements.txt
cd ../frontend && npm ci && npm run build
cd ../backend && python -m uvicorn main:app --port 8000
```

The database keeps the old schedule and device-count tables untouched; nothing
reads them any more.
