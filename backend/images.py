"""
Product pictures all go through here, so every one ends up the same shape:
an 800 x 600 JPEG, the item trimmed of surplus white border and centred on
white with a little breathing room. The web thumbnails and the PDF then look
consistent whatever size or format the original was.
"""
from __future__ import annotations
import uuid
from pathlib import Path
from PIL import Image, ImageChops, ImageOps, ImageFilter

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


def _trim_white(im: Image.Image, tolerance: int = 26) -> Image.Image:
    """
    Cut away the background so the item fills the frame. The background colour is
    read from the picture's edges (white, off-white or light grey all work). Thin
    frames, watermarks and small logos are ignored: the crop follows the biggest
    solid shape, so a hinge photographed on a huge white sheet is not a speck.
    """
    w, h = im.size
    # the background is the most common colour, judged on a small copy (a frame line cannot skew it)
    small = im.resize((96, 72))
    bgc = max(small.getcolors(96 * 72), key=lambda t: t[0])[1]
    bg = Image.new("RGB", im.size, bgc)
    mask = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > tolerance else 0)
    box = mask.getbbox()
    if not box:
        return im
    # drop thin frames, text and specks: keep only what survives a coarse erosion
    k = max(9, min(w, h) // 60) | 1
    solid = mask.filter(ImageFilter.MinFilter(k)).getbbox()
    if solid:
        x0, y0, x1, y1 = solid
        if (x1 - x0) >= 0.03 * w and (y1 - y0) >= 0.03 * h:
            g = k // 2 + 4
            box = (max(0, x0 - g), max(0, y0 - g), min(w, x1 + g), min(h, y1 + g))
    x0, y0, x1, y1 = box
    m = 6
    return im.crop((max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)))


def normalize_image(src: Path | str, dest_dir: Path) -> Path:
    """Read any picture, return the path of a fresh normalised JPEG in dest_dir."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as raw:
        im = _trim_white(_flatten(raw))
    # fit inside the canvas, enlarging small crops too (thumbnail() only ever shrinks); cap the
    # enlargement at 4x so a genuinely tiny original does not turn to mush
    fw, fh = CANVAS[0] - 2 * PAD, CANVAS[1] - 2 * PAD
    scale = min(fw / im.width, fh / im.height, 4.0)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", CANVAS, "white")
    canvas.paste(im, ((CANVAS[0] - im.width) // 2, (CANVAS[1] - im.height) // 2))
    dest = dest_dir / f"n2-{uuid.uuid4().hex}.jpg"
    canvas.save(dest, "JPEG", quality=88, optimize=True)
    return dest


def is_normalized(path: Path | str) -> bool:
    """Only pictures made by the current normaliser count; older ones get redone at startup."""
    p = Path(path)
    return p.exists() and p.name.startswith("n2-")


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
