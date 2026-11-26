"""
Cin7 Core, straight from the API instead of the Products Price List export.

Read-only from our side. The account id and key live in the server's .env
(CIN7_ACCOUNT_ID, CIN7_APP_KEY) and nowhere else. A sync does exactly what the
Excel import did: match on SKU, bring over name, category, unit, average cost
and the sell price, keep every photo, Intec code and note we already hold.
"""
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://inventory.dearsystems.com/ExternalApi/v2/"
PAGE = 1000                     # the most Cin7 hands over per call
PICTURES_PER_RUN = 150          # keep one click well inside Cin7's rate limit


def configured() -> bool:
    return bool(os.getenv("CIN7_ACCOUNT_ID") and os.getenv("CIN7_APP_KEY"))


class Cin7Error(Exception):
    pass


def _get(path: str, **params) -> dict:
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={
        "api-auth-accountid": os.getenv("CIN7_ACCOUNT_ID", ""),
        "api-auth-applicationkey": os.getenv("CIN7_APP_KEY", ""),
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Cin7Error("Cin7 refused the account id or key. Check the two CIN7 lines in .env on the server.")
        if e.code == 429:
            raise Cin7Error("Cin7 is rate limiting us. Try again in a minute.")
        raise Cin7Error(f"Cin7 answered {e.code} {e.reason}")
    except urllib.error.URLError as e:
        raise Cin7Error(f"Could not reach Cin7: {e.reason}")


def fetch_products() -> list[dict]:
    """Every product on the account, page by page."""
    out, page = [], 1
    while True:
        data = _get("product", Page=page, Limit=PAGE)
        items = data.get("Products") or []
        out.extend(items)
        if not items or len(out) >= int(data.get("Total") or 0):
            return out
        page += 1


def _num(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def _row(p: dict) -> dict:
    """One Cin7 product in the shape the Excel import worked from."""
    tiers = p.get("PriceTiers") or {}
    sell = None
    for k in ("Wholesale", "General"):          # the same order the export was read in
        sell = _num(tiers.get(k))
        if sell:
            break
    sell = sell or _num(p.get("PriceTier1"))
    pics = [a for a in (p.get("Attachments") or [])
            if str(a.get("ContentType") or "").lower().startswith("image/") and a.get("DownloadUrl")]
    pics.sort(key=lambda a: not a.get("IsDefault"))
    return {
        "sku": (p.get("SKU") or "").strip(), "name": (p.get("Name") or "").strip(),
        "category": (p.get("Category") or "").strip() or "Other",
        "unit": ((p.get("UOM") or "EACH").strip() or "EACH").upper(),
        "cost": _num(p.get("AverageCost")), "sell": sell,
        "brand": (p.get("Brand") or "").strip(),
        "deprecated": str(p.get("Status") or "").lower() == "deprecated",
        "description": (p.get("Description") or "") + " " + (p.get("ShortDescription") or ""),
        "picture": pics[0]["DownloadUrl"] if pics else "",
    }


_CLASS = re.compile(r"(classification|certification)\s*code", re.I)


def sync(db, models, guess_product_type, apply: bool) -> dict:
    """Look at what Cin7 has against what we hold. With apply, write it in."""
    rows = [_row(p) for p in fetch_products()]
    rows = [r for r in rows if r["sku"] and r["name"]]
    live = [r for r in rows if not r["deprecated"]]
    ours = {p.sku: p for p in db.query(models.Product).all()}
    new, changed, same, pictures_wanted = [], [], 0, 0
    for r in live:
        p = ours.get(r["sku"])
        if p is None:
            new.append(r)
            continue
        moved = (p.name != r["name"] or (p.category or "Other") != r["category"]
                 or (r["cost"] is not None and p.cost != r["cost"])
                 or (r["sell"] is not None and p.sell != r["sell"]))
        if moved:
            changed.append(r)
        else:
            same += 1
        if r["picture"] and not p.image_path:
            pictures_wanted += 1
    report = {
        "found": len(rows), "deprecated": len(rows) - len(live),
        "new": len(new), "changed": len(changed), "unchanged": same,
        "pictures_in_cin7": sum(1 for r in live if r["picture"]),
        "pictures_we_lack": pictures_wanted + sum(1 for r in new if r["picture"]),
        "with_classification": sum(1 for r in live if _CLASS.search(r["description"])),
        "sample_new": [f"{r['sku']} {r['name']}"[:60] for r in new[:6]],
        "applied": False,
    }
    if not apply:
        return report
    for r in live:
        p = ours.get(r["sku"])
        if p:
            p.name, p.category, p.unit = r["name"], r["category"], r["unit"]
            if r["cost"] is not None: p.cost = r["cost"]
            if r["sell"] is not None: p.sell = r["sell"]
            if r["brand"] and not p.brand: p.brand = r["brand"]
            if not p.product_type: p.product_type = guess_product_type(r["category"], r["name"])
        else:
            db.add(models.Product(sku=r["sku"], name=r["name"], category=r["category"], unit=r["unit"],
                                  cost=r["cost"], sell=r["sell"], brand=r["brand"], source="cin7",
                                  product_type=guess_product_type(r["category"], r["name"])))
    db.commit()
    report["applied"] = True
    report["when"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return report


def fetch_pictures(db, models, img_dir: Path, normalize_image) -> dict:
    """Pictures Cin7 holds for products that have none here, a batch at a time."""
    have = {p.sku: p for p in db.query(models.Product).filter(models.Product.image_path == "").all()}
    if not have:
        return {"fetched": 0, "failed": 0, "remaining": 0}
    todo = [(have[r["sku"]], r["picture"]) for r in (_row(p) for p in fetch_products())
            if r["sku"] in have and r["picture"] and not r["deprecated"]]
    fetched = failed = 0
    for p, url in todo[:PICTURES_PER_RUN]:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "image/*"}), timeout=60) as r:
                data = r.read()
            path = normalize_image(io.BytesIO(data), img_dir)
            if path:
                p.image_path = str(path); fetched += 1
            else:
                failed += 1
        except Exception:
            failed += 1
    db.commit()
    return {"fetched": fetched, "failed": failed, "remaining": max(0, len(todo) - PICTURES_PER_RUN)}


# ── The nightly refresh, and what the last run did ───────────────────────────
def _marker(data_dir: Path) -> Path:
    return data_dir / "cin7_sync.json"


def last_run(data_dir: Path) -> dict | None:
    try:
        return json.loads(_marker(data_dir).read_text())
    except Exception:
        return None


def remember(data_dir: Path, report: dict):
    try:
        _marker(data_dir).write_text(json.dumps(report))
    except Exception:
        pass
