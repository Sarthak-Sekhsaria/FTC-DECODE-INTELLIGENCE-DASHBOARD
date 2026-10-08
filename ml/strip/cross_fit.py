"""Cross-fitting for the v2 counter: honest numbers on videos a model never saw.

Videos are split into folds. For each fold, the strip detector is trained on the other folds and
run on this fold's videos, so every video gets lane responses from a detector that never saw it
(as the app's detector sees a user's video). The entry counter is then trained on the other
folds' responses with the score bar's count as the target, and counts this fold's matches.

  python cross_fit.py --data <strips> --bar <dir with sbAll_*.json> --work <dir>
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

# RAMPs whose lane was checked by eye (the lane on the RAMP all match; no camera cuts)
GOOD = "T01:b,T02:r,T02:b,T03:r,T03:b,T04:r,T05:r,T13:r,T13:b,T14:r,T14:b,T15:b,T17:r,T17:b,T23:r,T23:b,T26:r,T26:b,T27:r,T27:b,T28:r,T28:b,T29:r,T29:b".split(",")
# ... and of those, the ones with the score bar (the scorekeepers' count over time)
BAR = "T03:r,T03:b,T04:r,T05:r,T13:r,T13:b,T14:r,T14:b,T17:r,T17:b,T23:r,T23:b,T26:r,T26:b,T27:r,T27:b,T28:r,T28:b".split(",")
FOLDS = [["T03", "T13", "T02"], ["T04", "T14", "T27", "T15"], ["T05", "T17", "T26", "T29"], ["T23", "T28", "T01"]]
# lanes that placement put off the RAMP (checked by eye): nothing ever comes onto a RAMP there
ZERO = "T16:r,T16:b,T20:r,T20:b".split(",")


def run(cmd):
    print(">", " ".join(cmd[:3]), "...", flush=True)
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    lines = [l for l in (r.stdout + r.stderr).splitlines() if "arn" not in l and "torch.onnx" not in l and "tot +=" not in l]
    print("\n".join(lines[-14:]), flush=True)
    if r.returncode:
        raise SystemExit(f"failed: {' '.join(cmd)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--entry_init", default="")
    ap.add_argument("--skip_detector", action="store_true")
    ap.add_argument("--variants", default="", help="renditions besides the original, e.g. _360p,_240p")
    ap.add_argument("--neg", default="", help="dir of strips off the RAMP for the detector's RAMP output")
    ap.add_argument("--no_entry", action="store_true", help="only the fold detectors and their lane responses")
    ap.add_argument("--det_variants", default=None, help="renditions the detectors train on (default: --variants); '' for the originals only")
    a = ap.parse_args()
    variants = [""] + [v for v in a.variants.split(",") if v]
    expand = lambda rs: [f"{r.split(':')[0]}{v}:{r.split(':')[1]}" for r in rs for v in variants]
    # the detectors may be trained on the original videos only and still give the lane responses
    # of every rendition (the entry counter then learns small videos from a detector that never saw one)
    det_variants = [""] + [v for v in a.det_variants.split(",") if v] if a.det_variants is not None else variants
    expand_det = lambda rs: [f"{r.split(':')[0]}{v}:{r.split(':')[1]}" for r in rs for v in det_variants]
    os.makedirs(a.work, exist_ok=True)
    qdir = os.path.join(a.work, "q_oof")
    for k, fold in enumerate(FOLDS):
        train_v = [v for f in FOLDS for v in f if v not in fold]
        ramps = expand_det([r for r in GOOD if r.split(":")[0] in train_v])
        det = os.path.join(a.work, f"det_fold{k}.onnx")
        if not a.skip_detector:
            run([PY, "train_detector.py", "--data", a.data, "--train", ",".join(sorted({r.split(':')[0] for r in ramps})), "--ramps", ",".join(ramps), "--epochs", "12", "--every", "2" if len(det_variants) == 1 else "4", "--out", det] + (["--neg", a.neg] if a.neg else []))
            run([PY, "run_detector.py", "--model", det.replace(".onnx", ".pt"), "--data", a.data, "--keys", ",".join(f + v for f in fold for v in variants), "--out", qdir])
    # the off-RAMP lanes' responses, from a detector that never saw those videos
    if not a.skip_detector:
        run([PY, "run_detector.py", "--model", os.path.join(a.work, "det_fold0.pt"), "--data", a.data, "--keys", ",".join(sorted({z.split(':')[0] for z in ZERO})), "--out", qdir])
    if a.no_entry:
        return
    results = []
    for k, fold in enumerate(FOLDS):
        train_v = [v for f in FOLDS for v in f if v not in fold]
        ramps = expand([r for r in BAR if r.split(":")[0] in train_v + fold])
        cmd = [PY, "train_entry_real.py", "--q", qdir, "--bar", a.bar, "--ramps", ",".join(ramps), "--zero_ramps", ",".join(ZERO), "--val", ",".join(fold), "--steps", "3000", "--out", os.path.join(a.work, f"entry_fold{k}.pt")]
        if a.entry_init:
            cmd += ["--init", a.entry_init]
        run(cmd)


if __name__ == "__main__":
    main()
