"""
The ironmongery schedule itself: the numbers behind it (which doors get
which set, what that adds up to) and the documents that go out — the PDF
in the layout the office already sends, an Excel workbook, and a picking
list for the stores.
"""
import io
import re
from datetime import date
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

import models

COMPANY = {
    "name": "MF Services",
    "address": ["26 Doughcloyne Court Industrial Estate", "Sarsfield Rd, Wilton Co Cork"],
    "phone": "PH 021 4348996",
    "web": "www.mfservices.ie",
}
ASSETS_DIR = Path(__file__).parent / "assets"
LOGO_PATH = ASSETS_DIR / "logo.png"          # drop the company logo here; text wordmark otherwise
PRODUCT_IMG_DIR = Path("uploads") / "products"

_FLOOR_ORDER = ["Basement", "Lower Ground", "Ground", "Mezzanine", "First", "Second", "Third", "Fourth",
                "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth", "Penthouse", "Roof"]


def _floor_rank(f):
    if f in _FLOOR_ORDER:
        return (0, _FLOOR_ORDER.index(f), f)
    m = re.match(r"Level (\d+)", f or "")
    return (1, int(m.group(1)), f) if m else (2, 0, f or "")


def _ref_key(ref: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", ref or "")]


# ── The numbers ───────────────────────────────────────────────────────────────
def build_schedule(db, project: models.Project, estimator: str = "") -> dict:
    """
    Everything the documents need, as plain data. Prices come from the
    products' average cost from Cin7 (already in euro); a zero or blank cost
    means the stock has not landed yet. A product that is not in Cin7 falls
    back to the price on the last Intec schedule it appeared on.
    'priced_ok' says whether every line has a price.
    """
    types = {t.id: t for t in db.query(models.DoorType).filter(models.DoorType.project_id == project.id).all()}
    doors = db.query(models.Door).filter(models.Door.project_id == project.id).all()
    sets_by_id = {s.id: s for s in db.query(models.HardwareSet).all()}

    groups: dict[int, list] = {}
    no_set, excluded = [], 0
    for d in doors:
        t = types.get(d.door_type_id)
        if d.set_id:
            eff = d.set_id
        elif t and t.status == "excluded":
            excluded += 1
            continue
        else:
            eff = t.set_id if t else None
        if not eff or eff not in sets_by_id:
            no_set.append(d)
            continue
        groups.setdefault(eff, []).append(d)

    sets_out, summary, priced_ok, photo_missing = [], {}, True, set()
    for sid, ds in sorted(groups.items(), key=lambda kv: _code_key(sets_by_id[kv[0]].code)):
        s = sets_by_id[sid]
        refs = sorted(ds, key=lambda d: (_floor_rank(d.floor or ""), _ref_key(d.ref)))
        items, per_door = [], 0.0
        for it in s.items:
            p = it.product
            price = p.cost if p.cost else (p.sell if p.sell else None)
            if price is None:
                priced_ok = False
            else:
                per_door += price * it.qty
            if not p.image_path or not Path(p.image_path).exists():
                photo_missing.add(p.sku)
            items.append({"sku": p.sku, "name": p.name, "qty": it.qty, "unit": p.unit or "EACH",
                          "price": price, "value": (price * it.qty) if price is not None else None,
                          "image_path": p.image_path if p.image_path and Path(p.image_path).exists() else "",
                          "category": p.category or "Other"})
            agg = summary.setdefault(p.sku, {"sku": p.sku, "name": p.name, "unit": p.unit or "EACH",
                                             "category": p.category or "Other", "qty": 0, "price": price})
            agg["qty"] += it.qty * len(refs)
        sets_out.append({
            "id": s.id, "code": s.code, "name": s.name, "fire_rated": bool(s.fire_rated),
            "items": items, "doors": len(refs),
            "door_refs": [{"ref": d.ref, "floor": d.floor or "", "handed": bool(d.handed),
                           "type_code": types[d.door_type_id].code if d.door_type_id in types else ""} for d in refs],
            "per_door": round(per_door, 2), "value": round(per_door * len(refs), 2),
        })

    summary_rows = sorted(summary.values(), key=lambda r: r["sku"].upper())
    for r in summary_rows:
        r["value"] = round(r["price"] * r["qty"], 2) if r["price"] is not None else None
    total = round(sum(s["value"] for s in sets_out), 2) if priced_ok else None

    types_to_decide = [t for t in types.values() if t.status == "decide"]
    checks = []
    if types_to_decide:
        checks.append({"level": "warn", "text": f"{len(types_to_decide)} door type{'s' if len(types_to_decide) != 1 else ''} still to decide: "
                                                + ", ".join(sorted(t.code for t in types_to_decide))})
    if no_set:
        checks.append({"level": "warn", "text": f"{len(no_set)} door{'s' if len(no_set) != 1 else ''} without a set, left off the schedule"})
    empty_sets = [s["code"] for s in sets_out if not s["items"]]
    if empty_sets:
        checks.append({"level": "warn", "text": "Sets with no products: " + ", ".join(empty_sets)})
    if not project.quote_no:
        checks.append({"level": "info", "text": "No quote number on the project"})
    if not project.client:
        checks.append({"level": "info", "text": "No client on the project"})
    if photo_missing:
        checks.append({"level": "info", "text": f"{len(photo_missing)} product{'s' if len(photo_missing) != 1 else ''} without a photo: "
                                                + ", ".join(sorted(photo_missing)[:8]) + (" …" if len(photo_missing) > 8 else "")})
    if not priced_ok and sets_out:
        checks.append({"level": "info", "text": "Some products have no cost yet (not landed in Cin7), so the priced version is off"})
    if sets_out and not checks:
        checks.append({"level": "ok", "text": "Every door has a set and every set has products"})

    return {
        "project": {"id": project.id, "name": project.name, "client": project.client or "",
                    "site": project.site or "", "quote_no": project.quote_no or "", "rep": project.rep or "",
                    "estimator": estimator, "date": date.today().strftime("%d/%m/%Y")},
        "sets": sets_out, "summary": summary_rows,
        "doors_scheduled": sum(s["doors"] for s in sets_out), "doors_no_set": len(no_set),
        "doors_excluded": excluded, "doors_total": len(doors),
        "priced_ok": priced_ok and bool(sets_out), "total": total, "checks": checks,
        "item_count": sum(r["qty"] for r in summary_rows),
    }


def _code_key(code: str):
    m = re.search(r"(\d+)", code or "")
    return (code.split(m.group(1))[0] if m else code, int(m.group(1)) if m else 0, code)


# ── PDF ───────────────────────────────────────────────────────────────────────
def _latin(s) -> str:
    """Core PDF fonts cover Latin-1; swap the odd dash or quote rather than crash."""
    s = "" if s is None else str(s)
    s = (s.replace("–", "-").replace("—", "-").replace("‘", "'").replace("’", "'")
          .replace("“", '"').replace("”", '"').replace("…", "...").replace(" ", " "))
    return s.encode("latin-1", "replace").decode("latin-1")


def _money(v) -> str:
    return "" if v is None else f"{v:,.2f}"


class SchedulePDF(FPDF):
    def __init__(self, data: dict, priced: bool, title: str = ""):
        super().__init__(orientation="P", unit="mm", format="A4")
        self.data = data
        self.priced = priced
        self.doc_title = title
        self.set_margins(18, 16, 18)
        self.set_auto_page_break(auto=True, margin=28)
        self.alias_nb_pages()
        self.set_title(f"{data['project']['name']} - {title or 'Ironmongery schedule'}")

    # Page furniture -----------------------------------------------------
    def header(self):
        p = self.data["project"]
        self.set_font("Helvetica", "B", 11)
        self.set_xy(18, 16)
        self.cell(100, 6, _latin(f"Re: {p['name']}"), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        if LOGO_PATH.exists():
            self.image(str(LOGO_PATH), x=120, y=12, w=72)
        else:
            self.set_font("Helvetica", "B", 22)
            self.set_xy(120, 13)
            self.cell(72, 10, "MF", align="L")
            self.set_font("Helvetica", "", 12)
            self.set_xy(134, 15.5)
            self.cell(58, 6, "S E R V I C E S")
        self.set_y(34)

    def footer(self):
        self.set_y(-24)
        self.set_draw_color(120, 120, 120)
        self.line(18, self.get_y(), 192, self.get_y())
        self.set_font("Helvetica", "", 8)
        self.set_text_color(60, 60, 60)
        y = self.get_y() + 1.5
        for i, line in enumerate([COMPANY["name"], *COMPANY["address"], f"{COMPANY['phone']} {COMPANY['web']}"]):
            self.set_xy(18, y + i * 3.6)
            self.cell(120, 3.6, line)
        self.set_xy(150, y)
        self.cell(42, 3.6, self.data["project"]["date"], align="R")
        self.set_xy(150, y + 3.6)
        self.cell(42, 3.6, f"Page {self.page_no()}/{{nb}}", align="R")
        self.set_text_color(0, 0, 0)

    # Pieces -------------------------------------------------------------
    def cover(self):
        self.add_page()
        p = self.data["project"]
        self.set_font("Helvetica", "", 10)
        self.set_xy(18, 40); self.cell(80, 5, _latin(p["client"] or ""))
        rows = [("Date:", p["date"]), ("Quote No:", p["quote_no"]), ("Quote Ref:", p["name"]),
                ("Your Ref:", ""), ("", ""), ("Estimator:", p["estimator"]), ("Rep:", p["rep"])]
        y = 40
        for lbl, val in rows:
            self.set_xy(105, y); self.cell(28, 5, lbl)
            self.set_xy(133, y); self.cell(59, 5, _latin(val))
            y += 5
        self.set_font("Helvetica", "B", 10)
        self.set_xy(18, 62); self.cell(90, 5, _latin(f"Re: {p['name']}"))
        if p["site"]:
            self.set_font("Helvetica", "", 10)
            self.set_xy(18, 67); self.cell(90, 5, _latin(p["site"]))
        self.set_draw_color(0, 0, 0)
        self.line(18, 80, 192, 80)
        if self.doc_title:
            self.set_font("Helvetica", "B", 14)
            self.set_xy(18, 86); self.cell(100, 8, self.doc_title)
        self.set_font("Helvetica", "", 9)
        d = self.data
        self.set_xy(18, 96)
        self.cell(100, 5, f"{d['doors_scheduled']} doors across {len(d['sets'])} hardware set{'s' if len(d['sets']) != 1 else ''}, "
                          f"{d['item_count']} items.")

    def _table_header(self):
        self.set_font("Helvetica", "B", 8.5)
        self.set_draw_color(0, 0, 0)
        cols = self._cols()
        x = 18
        for name, w, align in cols:
            self.set_xy(x, self.get_y()); self.cell(w, 5, name, align=align); x += w
        self.set_y(self.get_y() + 5)
        self.line(18, self.get_y(), 192, self.get_y())
        self.set_y(self.get_y() + 1)

    def _cols(self):
        if self.priced:
            return [("Product Code", 34, "L"), ("Description", 92, "L"), ("Qty", 10, "R"),
                    ("Price", 14, "R"), ("Unit", 12, "L"), ("Value", 12, "R")]
        return [("Product Code", 36, "L"), ("Description", 108, "L"), ("Qty", 14, "R"), ("Unit", 16, "L")]

    def _row(self, sku, name, qty, unit, price=None, value=None):
        cols = self._cols()
        self.set_font("Helvetica", "", 8.5)
        desc_w = cols[1][1]
        lines = self.multi_cell(desc_w, 4, _latin(name), dry_run=True, output="LINES")
        h = max(4 * len(lines), 4)
        if self.get_y() + h > self.h - 28:
            self.add_page(); self._table_header()
        y = self.get_y()
        self.set_xy(18, y); self.cell(cols[0][1], 4, _latin(sku))
        self.set_xy(18 + cols[0][1], y); self.multi_cell(desc_w, 4, _latin(name))
        x = 18 + cols[0][1] + desc_w
        vals = [str(qty)] + ([_money(price), unit, _money(value)] if self.priced else [unit])
        for (n, w, align), v in zip(cols[2:], vals):
            self.set_xy(x, y); self.cell(w, 4, _latin(v), align=align); x += w
        self.set_y(y + h + 2)

    def set_page(self, s: dict):
        self.add_page()
        self.set_font("Helvetica", "", 10)
        self.set_xy(18, 36); self.cell(60, 6, _latin(f"Hardware Set Ref: {s['code']}"))
        self.set_xy(85, 36); self.cell(107, 6, _latin(s["name"]))
        self.set_y(46)
        self._table_header()
        for it in s["items"]:
            self._row(it["sku"], it["name"], it["qty"], it["unit"], it["price"], it["value"])
        if not s["items"]:
            self.set_font("Helvetica", "I", 8.5); self.cell(0, 5, "No products in this set yet", new_y=YPos.NEXT)
        # doors line
        self.line(18, self.get_y(), 192, self.get_y())
        self.set_y(self.get_y() + 1)
        self.set_font("Helvetica", "B", 8.5)
        n = s["doors"]
        if self.priced:
            self.set_xy(120, self.get_y()); self.cell(30, 5, f"{n} Door{'s' if n != 1 else ''} @", align="R")
            self.set_xy(150, self.get_y()); self.cell(20, 5, _money(s["per_door"]), align="R")
            self.set_xy(170, self.get_y()); self.cell(22, 5, _money(s["value"]), align="R")
        else:
            self.set_xy(120, self.get_y()); self.cell(72, 5, f"{n} Door{'s' if n != 1 else ''}", align="R")
        self.set_y(self.get_y() + 8)
        # door references
        self.set_fill_color(225, 225, 225)
        self.set_font("Helvetica", "B", 8.5)
        self.cell(174, 5, "Door Reference", fill=True, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        self.set_y(self.get_y() + 1)
        self.set_font("Helvetica", "", 8.5)
        refs = [r["ref"] + ("h" if r["handed"] else "") for r in s["door_refs"]]
        per_row, cw = 6, 29
        for i in range(0, len(refs), per_row):
            if self.get_y() + 5 > self.h - 28:
                self.add_page()
            x = 18
            for r in refs[i:i + per_row]:
                self.set_xy(x, self.get_y()); self.cell(cw, 4.5, _latin(r)); x += cw
            self.set_y(self.get_y() + 4.5)
        # photos
        photos = [it for it in s["items"] if it["image_path"]]
        if photos:
            self.set_y(self.get_y() + 4)
            per_row, bw, bh = 4, 43.5, 34
            for i in range(0, len(photos), per_row):
                if self.get_y() + bh + 6 > self.h - 28:
                    self.add_page()
                y = self.get_y(); x = 18
                for it in photos[i:i + per_row]:
                    try:
                        self.image(it["image_path"], x=x + 4, y=y, w=bw - 8, h=bh - 6, keep_aspect_ratio=True)
                    except Exception:
                        pass
                    self.set_xy(x, y + bh - 5); self.set_font("Helvetica", "", 7.5)
                    self.cell(bw, 4, _latin(it["sku"]), align="C")
                    x += bw
                self.set_y(y + bh + 2)

    def summary_page(self, picking: bool = False):
        self.add_page()
        self.set_font("Helvetica", "B", 13)
        self.set_xy(18, 36); self.cell(100, 7, "Picking List" if picking else "Product Summary")
        self.set_y(46)
        rows = self.data["summary"]
        if picking:
            self.set_font("Helvetica", "B", 8.5)
            for name, w in [("", 8), ("Product Code", 34), ("Description", 104), ("Qty", 12), ("Unit", 16)]:
                self.cell(w, 5, name, align="R" if name == "Qty" else "L")
            self.set_y(self.get_y() + 5); self.line(18, self.get_y(), 192, self.get_y()); self.set_y(self.get_y() + 1)
            by_cat: dict[str, list] = {}
            for r in rows:
                by_cat.setdefault(r["category"], []).append(r)
            for cat in sorted(by_cat):
                if self.get_y() + 12 > self.h - 28:
                    self.add_page()
                self.set_font("Helvetica", "B", 8.5); self.set_y(self.get_y() + 2)
                self.cell(174, 5, _latin(cat), new_x=XPos.LMARGIN, new_y=YPos.NEXT)
                self.set_font("Helvetica", "", 8.5)
                for r in by_cat[cat]:
                    lines = self.multi_cell(104, 4, _latin(r["name"]), dry_run=True, output="LINES")
                    h = max(4 * len(lines), 4)
                    if self.get_y() + h > self.h - 28:
                        self.add_page()
                    y = self.get_y()
                    self.rect(19, y + 0.3, 3.4, 3.4)
                    self.set_xy(26, y); self.cell(34, 4, _latin(r["sku"]))
                    self.set_xy(60, y); self.multi_cell(104, 4, _latin(r["name"]))
                    self.set_xy(164, y); self.cell(12, 4, str(r["qty"]), align="R")
                    self.set_xy(176, y); self.cell(16, 4, _latin(r["unit"]))
                    self.set_y(y + h + 2)
            return
        self._table_header()
        for r in rows:
            self._row(r["sku"], r["name"], r["qty"], r["unit"], r["price"], r["value"])
        if self.priced:
            self.line(18, self.get_y(), 192, self.get_y()); self.set_y(self.get_y() + 1)
            self.set_font("Helvetica", "B", 9)
            self.set_xy(120, self.get_y()); self.cell(50, 6, "Total Price:", align="R")
            self.set_xy(170, self.get_y()); self.cell(22, 6, _money(self.data["total"]), align="R")

    def notes_page(self):
        self.add_page()
        self.set_font("Helvetica", "B", 10)
        self.set_xy(18, 36); self.cell(40, 6, "Notes:")


def schedule_pdf(data: dict, priced: bool = False) -> bytes:
    pdf = SchedulePDF(data, priced=priced and data.get("priced_ok", False))
    pdf.cover()
    for s in data["sets"]:
        pdf.set_page(s)
    pdf.summary_page()
    pdf.notes_page()
    return bytes(pdf.output())


def picking_list_pdf(data: dict) -> bytes:
    pdf = SchedulePDF(data, priced=False, title="Picking List")
    pdf.cover()
    pdf.summary_page(picking=True)
    return bytes(pdf.output())


# ── Excel ─────────────────────────────────────────────────────────────────────
def schedule_excel(data: dict, priced: bool = False) -> bytes:
    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    priced = priced and data.get("priced_ok", False)
    wb = openpyxl.Workbook()
    bold = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="E6E3DC")
    thin = Side(style="thin", color="999999")
    p = data["project"]

    def header(ws, cols):
        ws.append(cols)
        for c in ws[ws.max_row]:
            c.font = bold; c.fill = head_fill; c.border = Border(bottom=thin)

    def widths(ws, ws_widths):
        for i, w in enumerate(ws_widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    # Sets
    ws = wb.active; ws.title = "Schedule"
    ws.append([f"{p['name']}"]); ws["A1"].font = Font(bold=True, size=14)
    ws.append([f"Quote {p['quote_no']}" if p["quote_no"] else "", p["client"], p["date"]])
    ws.append([])
    for s in data["sets"]:
        ws.append([f"Hardware Set Ref: {s['code']}", s["name"], f"{s['doors']} doors"])
        ws[ws.max_row][0].font = bold; ws[ws.max_row][1].font = bold
        header(ws, ["Product Code", "Description", "Qty per door", "Unit"] + (["Price", "Value per door"] if priced else []) + ["Total qty"])
        for it in s["items"]:
            ws.append([it["sku"], it["name"], it["qty"], it["unit"]] + ([it["price"], it["value"]] if priced else []) + [it["qty"] * s["doors"]])
        ws.append(["Door Reference", ", ".join(r["ref"] + ("h" if r["handed"] else "") for r in s["door_refs"])])
        ws[ws.max_row][0].font = bold
        ws[ws.max_row][1].alignment = Alignment(wrap_text=True, vertical="top")
        if priced:
            ws.append(["", "", "", "", f"{s['doors']} doors @", s["per_door"], s["value"]])
        ws.append([])
    widths(ws, [24, 70, 12, 8, 10, 14, 12])

    # Doors
    ws2 = wb.create_sheet("Doors")
    header(ws2, ["Door", "Floor", "Door type", "Handed", "Set", "Set name"])
    for s in data["sets"]:
        for r in s["door_refs"]:
            ws2.append([r["ref"], r["floor"], r["type_code"], "Yes" if r["handed"] else "", s["code"], s["name"]])
    widths(ws2, [14, 14, 12, 8, 10, 40])

    # Product summary
    ws3 = wb.create_sheet("Product summary")
    header(ws3, ["Product Code", "Description", "Category", "Qty", "Unit"] + (["Price", "Value"] if priced else []))
    for r in data["summary"]:
        ws3.append([r["sku"], r["name"], r["category"], r["qty"], r["unit"]] + ([r["price"], r["value"]] if priced else []))
    if priced:
        ws3.append([]); ws3.append(["", "", "", "", "", "Total", data["total"]]); ws3[ws3.max_row][6].font = bold
    widths(ws3, [24, 70, 18, 8, 8, 10, 12])

    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    return buf.read()
