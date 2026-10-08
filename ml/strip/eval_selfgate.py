"""Held-out counts with self-referenced RAMP gating: a frame counts as seen only when its strip
looks at least `frac` as much like a RAMP as this RAMP typically does in this video (the
`pct` percentile of the RAMP output over the match). A lane that the camera follower lost (it
points at people or the floor for a while) drops far below the RAMP's own level and is not
counted; a RAMP that the RAMP output scores low throughout (an unfamiliar view) keeps its frames.

  python eval_selfgate.py --ball det.pt --ramp det_with_ramp_head.pt --entry e1.pt,e2.pt --data <strips_app> --bar <dir> --official officialAll.json --keys ...
"""

import argparse
import json
import os

import numpy as np
import torch

from data import BINS, SH, SW
from detector import StripDetector
from entry_model import EntryNet

SETTLE = 3.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ball", required=True)
    ap.add_argument("--ramp", required=True)
    ap.add_argument("--entry", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--official", required=True)
    ap.add_argument("--keys", required=True)
    ap.add_argument("--frac", type=float, default=0.5)
    ap.add_argument("--pct", type=float, default=90)
    a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ball = StripDetector().to(dev).eval()
    ball.load_state_dict(torch.load(a.ball, map_location=dev), strict=False)
    rampnet = StripDetector().to(dev).eval()
    rampnet.load_state_dict(torch.load(a.ramp, map_location=dev))
    ents = []
    for p in a.entry.split(","):
        e = EntryNet().to(dev).eval()
        e.load_state_dict(torch.load(p, map_location=dev))
        ents.append(e)
    off = json.load(open(a.official))
    tot = {"plain": 0.0, "gated": 0.0}
    n_off = 0
    for key in a.keys.split(","):
        meta = json.load(open(os.path.join(a.data, f"{key}.json")))
        m = meta["meta"]
        raw = np.memmap(os.path.join(a.data, f"{key}.bin"), dtype=np.uint8, mode="r").reshape(len(m), SH, SW, 3)
        barf = os.path.join(a.bar, f"sbAll_{key}.json")
        w = json.load(open(barf))["window"] if os.path.exists(barf) else None
        start, end = (w["start"], w["buzzer"] + SETTLE) if w else (off[key]["window"][0], off[key]["window"][1] + SETTLE)
        for ai, al in enumerate(["red", "blue"]):
            idx = [i for i, x in enumerate(m) if x["a"] == ai]
            if not idx or not off[key][al]:
                continue
            t = np.array([m[i]["t"] for i in idx])
            ok = np.array([m[i]["ok"] for i in idx], np.float32)
            q = np.zeros((len(idx), BINS), np.float32)
            r = np.zeros(len(idx), np.float32)
            with torch.no_grad():
                for j in range(0, len(idx), 1024):
                    xb = torch.from_numpy(np.asarray(raw[idx[j:j + 1024]])).to(dev).permute(0, 3, 1, 2).float() / 255
                    q[j:j + 1024] = torch.sigmoid(ball(xb)[0]).cpu().numpy()
                    r[j:j + 1024] = torch.sigmoid(rampnet(xb)[1]).cpu().numpy()
            win = (t >= start) & (t <= end)
            ref = np.percentile(r[win & (ok > 0)], a.pct) if (win & (ok > 0)).any() else 1.0
            gate = (r >= a.frac * ref).astype(np.float32)
            res = {}
            for name, valid in (("plain", ok), ("gated", ok * gate)):
                qq = q * valid[:, None]
                x = torch.from_numpy(np.stack([qq, np.repeat(valid[:, None], BINS, axis=1)])[None]).to(dev)
                with torch.no_grad():
                    lam = torch.stack([e(x) for e in ents]).mean(0)[0].cpu().numpy()
                res[name] = float(lam[win].sum())
            o = off[key][al][0]
            n_off += o
            for name in res:
                tot[name] += abs(res[name] - o)
            print(f"{key:4s} {al:4s}: official {o:4d} | plain {res['plain']:6.1f} ({res['plain'] - o:+6.1f}) | self-gated {res['gated']:6.1f} ({res['gated'] - o:+6.1f}) | RAMP ref {ref:.2f}, frames kept {(gate[win] * ok[win]).mean():.2f}", flush=True)
    print(f"TOTAL |error|: plain {tot['plain']:.0f} ({100 * tot['plain'] / n_off:.1f}%), self-gated {tot['gated']:.0f} ({100 * tot['gated'] / n_off:.1f}%) of {n_off}")


if __name__ == "__main__":
    main()
