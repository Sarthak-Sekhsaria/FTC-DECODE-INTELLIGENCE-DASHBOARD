"""The v2 counter on videos it was never trained on, against the official CLASSIFIED counts.

Vision only: the score bar is not used for counting here, only (where a video has one) for the
match window. Videos without a bar use the window from the official timing (officialAll.json).
Prints per RAMP: counted, official, error, and the share of the match the RAMP was followed.

  python eval_heldout.py --det det.pt --entry entry.pt --data <strips15> --bar <dir> --official officialAll.json --keys 01,02,...
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
    ap.add_argument("--det", required=True)
    ap.add_argument("--entry", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--official", required=True)
    ap.add_argument("--keys", required=True)
    ap.add_argument("--v1", default="", help="pass1 dir: also report the v1 counter's count in the window")
    ap.add_argument("--no_ramp", action="store_true", help="a detector without the RAMP output")
    ap.add_argument("--use_ramp", action="store_true", help="frames the detector does not take for a RAMP are unseen")
    a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    det = StripDetector().to(dev).eval()
    det.load_state_dict(torch.load(a.det, map_location=dev), strict=not a.no_ramp)
    # one entry counter, or several (comma-separated) averaged as the app's ensemble is
    ents = []
    for path in a.entry.split(","):
        e = EntryNet().to(dev).eval()
        e.load_state_dict(torch.load(path, map_location=dev))
        ents.append(e)
    ent = lambda x: torch.stack([e(x) for e in ents]).mean(0)
    off = json.load(open(a.official))
    tot_err = tot_off = tot_v1 = 0
    rows = []
    for key in a.keys.split(","):
        if not os.path.exists(os.path.join(a.data, f"{key}.json")) or key not in off:
            print(f"{key}: no strips or no official result")
            continue
        meta = json.load(open(os.path.join(a.data, f"{key}.json")))
        m = meta["meta"]
        raw = np.memmap(os.path.join(a.data, f"{key}.bin"), dtype=np.uint8, mode="r").reshape(len(m), SH, SW, 3)
        barf = os.path.join(a.bar, f"sbAll_{key}.json")
        w = json.load(open(barf))["window"] if os.path.exists(barf) else None
        if w:
            start, end = w["start"], w["buzzer"] + SETTLE
        elif off[key]["window"]:
            start, end = off[key]["window"][0], off[key]["window"][1] + SETTLE
        else:
            print(f"{key}: no match window")
            continue
        p1 = json.load(open(os.path.join(a.v1, f"{key}.json"))) if a.v1 and os.path.exists(os.path.join(a.v1, f"{key}.json")) else None
        for ai, al in enumerate(["red", "blue"]):
            idx = [i for i, x in enumerate(m) if x["a"] == ai]
            if not idx or not off[key][al]:
                continue
            t = np.array([m[i]["t"] for i in idx])
            ok = np.array([m[i]["ok"] for i in idx], np.float32)
            q = np.zeros((len(idx), BINS), np.float32)
            ramp = np.zeros(len(idx), np.float32)
            with torch.no_grad():
                for j in range(0, len(idx), 1024):
                    xb = torch.from_numpy(np.asarray(raw[idx[j:j + 1024]])).to(dev).permute(0, 3, 1, 2).float() / 255
                    bins, rl = det(xb)
                    q[j:j + 1024] = torch.sigmoid(bins).cpu().numpy()
                    ramp[j:j + 1024] = torch.sigmoid(rl).cpu().numpy()
            # a frame counts when the camera was followed and the strip shows a RAMP
            if a.use_ramp:
                ok = ok * (ramp > 0.5)
            q *= ok[:, None]
            x = torch.from_numpy(np.stack([q, np.repeat(ok[:, None], BINS, axis=1)])[None]).to(dev)
            with torch.no_grad():
                lam = ent(x)[0].cpu().numpy()
            win = (t >= start) & (t <= end)
            got = float(lam[win].sum())
            o = off[key][al][0]
            v1 = None
            if p1:
                ln = next((l for l in p1["lanes"] if l["alliance"] == al), None)
                if ln and ln["res"]:
                    v1 = sum(1 for c in ln["res"]["counted"] if start <= c["t"] <= end)
            err = got - o
            tot_err += abs(err)
            tot_off += o
            if v1 is not None:
                tot_v1 += abs(v1 - o)
            rows.append((key, al, got, o, v1, ok[win].mean()))
            print(f"{key:4s} {al:4s}: v2 {got:6.1f}  official {o:4d}  error {err:+6.1f} ({100 * err / max(1, o):+5.0f}%)" + (f"  | v1 {v1:4d} ({v1 - o:+d})" if v1 is not None else "") + f"  | followed {100 * ok[win].mean():.0f}%", flush=True)
    print(f"TOTAL |error| v2 {tot_err:.0f} of {tot_off} ({100 * tot_err / max(1, tot_off):.1f}%)" + (f"; v1 {tot_v1} ({100 * tot_v1 / max(1, tot_off):.1f}%)" if a.v1 else ""))


if __name__ == "__main__":
    main()
