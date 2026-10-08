"""Score the v2 counter on real matches against the scorekeepers' count.

For each video and RAMP: the strip detector's lane responses (run_detector.py) go through the
entry counter, and its count from the match start to SETTLE_SEC after the buzzer is compared
with the official CLASSIFIED count read from the broadcast's score bar (the scorekeepers' live
count) at the same moment and at the end. An image shows both running counts over the match.

  python eval_entry.py --model entry.pt --q <q dir> --bar <dir with sbAll_<key>.json> --keys T14,T23
"""

import argparse
import json
import os

import numpy as np
import torch
from PIL import Image, ImageDraw

from entry_model import EntryNet

SETTLE_SEC = 3.0


def official(bar_file, al):
    """Accepted CLASSIFIED counts over time (two equal readings in a row), as the app reads them."""
    rows = [r for r in json.load(open(bar_file))["rows"] if r.get("bar") is not False]
    out, cur, cand, st = [], None, None, 0
    for r in rows:
        v = r[al]["classified"]
        if v is None:
            continue
        st = st + 1 if v == cand else 1
        cand = v
        if st >= 2 and cand != cur:
            out.append((r["t"], cand))
            cur = cand
    return out


def count_at(steps, t):
    v = 0
    for tt, c in steps:
        if tt <= t:
            v = c
    return v


def run(net, q, ok, dev):
    x = torch.from_numpy(np.stack([q, np.repeat(ok[:, None].astype(np.float32), q.shape[1], axis=1)])[None]).to(dev)
    x = x.permute(0, 1, 2, 3)  # 1 x 2 x T x 36
    with torch.no_grad():
        return net(x)[0].cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--q", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--keys", required=True)
    ap.add_argument("--img", default="")
    a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net = EntryNet().to(dev).eval()
    net.load_state_dict(torch.load(a.model, map_location=dev))
    rows = []
    tot_err, tot_off = 0, 0
    for key in a.keys.split(","):
        d = np.load(os.path.join(a.q, f"{key}.npz"))
        bar = json.load(open(os.path.join(a.bar, f"sbAll_{key}.json")))
        w = bar["window"]
        for al in ["red", "blue"]:
            if f"{al}_q" not in d:
                continue
            t, q, ok = d[f"{al}_t"], d[f"{al}_q"], d[f"{al}_ok"]
            lam = run(net, q, ok, dev)
            steps = official(os.path.join(a.bar, f"sbAll_{key}.json"), al)
            if w is None or not steps:
                continue
            start, end = w["start"], w["buzzer"] + SETTLE_SEC
            inwin = (t >= start) & (t <= end)
            got = float(lam[inwin].sum())
            off_end = steps[-1][1]
            err = got - off_end
            tot_err += abs(err)
            tot_off += off_end
            print(f"{key} {al}: counted {got:.1f}, official {off_end} (at the buzzer+1 s {count_at(steps, w['buzzer'] + 1)}) -> error {err:+.1f} ({100 * err / max(1, off_end):+.0f}%); tracked {100 * ok[inwin].mean():.0f}% of frames")
            rows.append((f"{key} {al}: v2 {got:.0f} / official {off_end}", t, np.cumsum(np.where(inwin, lam, 0)), steps, start, end))
    print(f"total |error| {tot_err:.0f} of {tot_off} official CLASSIFIED ({100 * tot_err / max(1, tot_off):.1f}%)")
    if a.img and rows:
        W, H = 900, 120
        sheet = Image.new("RGB", (W, H * len(rows)), (25, 25, 25))
        dr = ImageDraw.Draw(sheet)
        for k, (label, t, cum, steps, start, end) in enumerate(rows):
            y0 = k * H
            top = max(cum[-1], steps[-1][1], 1)
            X = lambda tt: int((tt - start) / (end - start + 5) * (W - 20)) + 10
            Y = lambda c: y0 + H - 10 - int(c / top * (H - 30))
            pts = [(X(tt), Y(c)) for tt, c in zip(t, cum) if start <= tt <= end]
            dr.line(pts, fill=(80, 220, 255), width=2)
            prev = (X(start), Y(0))
            for tt, c in steps:
                if tt < start:
                    continue
                p = (X(min(tt, end + 5)), Y(c))
                dr.line([prev, (p[0], prev[1]), p], fill=(255, 90, 90), width=1)
                prev = p
            dr.text((12, y0 + 4), label + "  (blue line: v2, red steps: score bar)", fill=(255, 255, 0))
        sheet.save(a.img)


if __name__ == "__main__":
    main()
