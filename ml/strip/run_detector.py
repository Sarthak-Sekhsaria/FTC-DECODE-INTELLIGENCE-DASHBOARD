"""Run the strip detector over a video's strips: the per-frame lane responses (q maps) for the
entry counter, and an image to look at (the lane over time above, the detector's response below).

  python run_detector.py --model det.pt --data <strips dir> --keys T14,T26 --out <dir>
"""

import argparse
import json
import os

import numpy as np
import torch
from PIL import Image, ImageDraw

from data import BINS, SH, SW
from detector import StripDetector


def qmaps(net, data_dir, key, dev, has_ramp=True):
    meta = json.load(open(os.path.join(data_dir, f"{key}.json")))
    m = meta["meta"]
    raw = np.memmap(os.path.join(data_dir, f"{key}.bin"), dtype=np.uint8, mode="r").reshape(len(m), SH, SW, 3)
    out = {}
    for a, al in enumerate(["red", "blue"]):
        idx = [i for i, x in enumerate(m) if x["a"] == a]
        if not idx:
            continue
        q = np.zeros((len(idx), BINS), np.float32)
        ramp = np.zeros(len(idx), np.float32)
        with torch.no_grad():
            for j in range(0, len(idx), 1024):
                xb = torch.from_numpy(np.asarray(raw[idx[j:j + 1024]])).to(dev).permute(0, 3, 1, 2).float() / 255
                bins, rl = net(xb)
                q[j:j + 1024] = torch.sigmoid(bins).cpu().numpy()
                ramp[j:j + 1024] = torch.sigmoid(rl).cpu().numpy() if has_ramp else 1.0
        out[al] = {
            "t": np.array([m[i]["t"] for i in idx], np.float32),
            "ok": np.array([m[i]["ok"] for i in idx], np.uint8),
            "q": q,
            "ramp": ramp,
            "kymo": np.stack([np.asarray(raw[i, 12:28]).mean(axis=0) for i in idx]).astype(np.uint8),  # n x 144 x 3
        }
    return meta, out


def render(meta, out, path, spp=0.2):
    rows = []
    for al, d in out.items():
        t0, t1 = d["t"][0], d["t"][-1]
        W = int((t1 - t0) / spp) + 1
        img = np.zeros((72 + 4 + 72, W, 3), np.uint8)
        for j in range(len(d["t"])):
            x = int((d["t"][j] - t0) / spp)
            img[:72, x] = d["kymo"][j][::-2]
            col = (d["q"][j][::-1] * 255).astype(np.uint8)
            img[76:, x] = np.repeat(np.repeat(col, 2)[:, None], 3, axis=1)
            if not d["ok"][j]:
                img[72:76, x] = (255, 0, 0)
        rows.append((f"{meta['key']} {al}", Image.fromarray(img)))
    W = max(r[1].size[0] for r in rows)
    sheet = Image.new("RGB", (W, len(rows) * 165), (30, 30, 30))
    dr = ImageDraw.Draw(sheet)
    for k, (label, im) in enumerate(rows):
        dr.text((4, k * 165), label, fill=(255, 255, 0))
        sheet.paste(im, (0, k * 165 + 13))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--keys", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net = StripDetector().to(dev).eval()
    # a detector trained without strips off the RAMP has no RAMP output: every frame counts as a RAMP
    missing = net.load_state_dict(torch.load(a.model, map_location=dev), strict=False).missing_keys
    if any(not k.startswith("ramp.") for k in missing):
        raise SystemExit(f"model does not match: missing {missing}")
    os.makedirs(a.out, exist_ok=True)
    for key in a.keys.split(","):
        meta, out = qmaps(net, a.data, key, dev, has_ramp=not missing)
        np.savez_compressed(os.path.join(a.out, f"{key}.npz"), **{f"{al}_{k}": v for al, d in out.items() for k, v in d.items() if k != "kymo"})
        if a.render:
            render(meta, out, os.path.join(a.out, f"{key}.png"))
        print(key, {al: d["q"].shape for al, d in out.items()})


if __name__ == "__main__":
    main()
