"""
Purge all auto-harvested legend templates (files + database rows).

Run this with the backend STOPPED, from the backend folder:

    python purge_legend_templates.py

Safe to run any time: the app re-harvests clean templates from each
drawing's legend automatically on the next upload. Manually snipped
templates are not touched.
"""

import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "symbol_counter.db")

if not os.path.exists(DB):
    raise SystemExit(f"No database found at {DB} — run from the backend folder.")

con = sqlite3.connect(DB)
rows = con.execute(
    "select id, image_path from global_templates where image_path like '%legend_%'"
).fetchall()

removed_files = 0
for _id, path in rows:
    if path and os.path.exists(path):
        os.remove(path)
        removed_files += 1

con.execute("delete from global_templates where image_path like '%legend_%'")
con.commit()

print(f"Purged {len(rows)} legend-harvested templates ({removed_files} image files).")
print("They will be re-created cleanly the next time a drawing is uploaded.")
