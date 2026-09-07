"""
Measure detection accuracy against hand-counted ground truth.

    python evaluate.py                      # all sheets in ground_truth.json
    python evaluate.py --pdf path/to.pdf    # one sheet, counts only (no truth)

ground_truth.json maps a PDF filename (or its uploads folder id) to the
true device counts by legend label, exactly as written in the drawing's
legend. Fill it in by counting a few sheets by hand:

    {
      "FRDBA07-EDC-65-10-DR-E-006501.pdf": {
        "SMOKE DETECTOR": 14,
        "BREAK GLASS MANUAL CALL POINT": 3,
        "FIXED CCTV CAMERA": 2
      }
    }

No detector change ships unless this script's numbers hold or improve.
"""

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detection.pipeline import parse_pdf_page_text, find_legend_region   # noqa: E402
from detection.vector import run_vector_detection                       # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TRUTH = os.path.join(HERE, "ground_truth.json")


def count_sheet(pdf_path: str) -> collections.Counter:
    counts = collections.Counter()
    page = 1
    while True:
        words, dims = parse_pdf_page_text(pdf_path, page)
        if not words and page > 1:
            break
        lb = find_legend_region(words, dims)
        r = run_vector_detection(pdf_path, page, lb)
        if not r["is_vector"]:
            print(f"  page {page}: not a vector page (scanned?) — vector engine skipped")
        counts.update(d["label"] for d in r["detections"])
        page += 1
        if page > 20:
            break
    return counts


def norm(label: str) -> str:
    return " ".join(label.upper().split())


def evaluate(pdf_path: str, truth: dict) -> tuple:
    got = {norm(k): v for k, v in count_sheet(pdf_path).items()}
    want = {norm(k): v for k, v in truth.items()}
    tp = fp = fn = 0
    rows = []
    for label in sorted(set(got) | set(want)):
        g, w = got.get(label, 0), want.get(label, 0)
        tp += min(g, w)
        fp += max(g - w, 0)
        fn += max(w - g, 0)
        mark = "OK " if g == w else ("+%d" % (g - w) if g > w else "-%d" % (w - g))
        rows.append(f"    {mark:4s} {label:45s} found {g:3d}  true {w:3d}")
    return tp, fp, fn, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", help="Count one PDF (no ground truth needed)")
    ap.add_argument("--uploads", default=os.path.join(HERE, "uploads"),
                    help="Folder holding <id>/drawing.pdf uploads")
    args = ap.parse_args()

    if args.pdf:
        for label, n in count_sheet(args.pdf).most_common():
            print(f"  {n:3d}  {label}")
        return

    if not os.path.exists(TRUTH):
        raise SystemExit(f"No {TRUTH} yet — see the docstring for the format.")
    truth_all = json.load(open(TRUTH))
    total_tp = total_fp = total_fn = 0
    for key, truth in truth_all.items():
        if not truth:
            continue
        cands = [key, os.path.join(args.uploads, key, "drawing.pdf"), os.path.join(args.uploads, key)]
        pdf = next((c for c in cands if os.path.isfile(c)), None)
        if not pdf:
            print(f"\n{key}: PDF not found (looked in uploads/<id>/drawing.pdf)")
            continue
        tp, fp, fn, rows = evaluate(pdf, truth)
        total_tp += tp; total_fp += fp; total_fn += fn
        prec = tp / (tp + fp) if tp + fp else 0
        rec = tp / (tp + fn) if tp + fn else 0
        print(f"\n{key}: precision {prec:.0%}  recall {rec:.0%}")
        print("\n".join(rows))
    if total_tp + total_fp + total_fn:
        prec = total_tp / (total_tp + total_fp) if total_tp + total_fp else 0
        rec = total_tp / (total_tp + total_fn) if total_tp + total_fn else 0
        print(f"\nOVERALL: precision {prec:.0%}  recall {rec:.0%}  "
              f"(matched {total_tp}, extra {total_fp}, missed {total_fn})")


if __name__ == "__main__":
    main()
