"""
Product pictures all go through here, so every one ends up the same shape:
an 800 x 600 JPEG, the item trimmed of surplus white border and centred on
white with a little breathing room. The web thumbnails and the PDF then look
consistent whatever size or format the original was.
"""
from __future__ import annotations
import uuid
from pathlib import Path
from PIL import Image, ImageChops, ImageOps

CANVAS = (800, 600)
PAD = 40


def _flatten(im: Image.Image) -> Image.Image:
    """Transparent PNGs onto white; everything else to plain RGB."""
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.split()[-1])
        return bg
    return im.convert("RGB")


def _trim_white(im: Image.Image, tolerance: int = 18) -> Image.Image:
    """Cut away near-white margins so a hinge photographed on a big white sheet is not a speck."""
    bg = Image.new("RGB", im.size, (255, 255, 255))
    diff = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > tolerance else 0)
    box = diff.getbbox()
    if not box:
        return im
    x0, y0, x1, y1 = box
    m = 6
    return im.crop((max(0, x0 - m), max(0, y0 - m), min(im.width, x1 + m), min(im.height, y1 + m)))


def normalize_image(src: Path | str, dest_dir: Path) -> Path:
    """Read any picture, return the path of a fresh normalised JPEG in dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as raw:
        im = _trim_white(_flatten(raw))
    im.thumbnail((CANVAS[0] - 2 * PAD, CANVAS[1] - 2 * PAD), Image.LANCZOS)
    canvas = Image.new("RGB", CANVAS, "white")
    canvas.paste(im, ((CANVAS[0] - im.width) // 2, (CANVAS[1] - im.height) // 2))
    dest = dest_dir / f"{uuid.uuid4().hex}.jpg"
    canvas.save(dest, "JPEG", quality=88, optimize=True)
    return dest


def is_normalized(path: Path | str) -> bool:
    p = Path(path)
    if not p.exists() or p.suffix.lower() != ".jpg":
        return False
    try:
        with Image.open(p) as im:
            return im.size == CANVAS and im.mode == "RGB"
    except Exception:
        return False


def normalize_all(db, product_model, dest_dir: Path) -> int:
    """One-off tidy of pictures already stored. Returns how many were redone."""
    done = 0
    for p in db.query(product_model).filter(product_model.image_path != "", product_model.image_path.isnot(None)).all():
        old = Path(p.image_path)
        if not old.exists() or is_normalized(old):
            continue
        try:
            new = normalize_image(old, dest_dir)
        except Exception:
            continue
        p.image_path = str(new)
        try: old.unlink()
        except OSError: pass
        done += 1
    if done:
        db.commit()
    return done
