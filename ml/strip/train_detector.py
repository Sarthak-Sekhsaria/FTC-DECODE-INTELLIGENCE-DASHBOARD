"""Train the RAMP strip detector (detector.py) and export it to ONNX.

Labels come from two places:
- Real strips: slots where the v1 queue counter's decoded queue and the slot's own evidence
  clearly agree (data.py). These are ARTIFACTS resting in the queue, and empty slots.
- ARTIFACTS pasted onto real strips at any position along the lane, sharp or blurred along it,
  for the ARTIFACTS that roll down the RAMP (through an open GATE or onto the queue): the v1
  counter never labelled those.
Augmentation covers a lane found slightly off, other cameras and lighting, and things in front
of the RAMP (blocks of robot / person colours, which must not read as ARTIFACTS).

  python train_detector.py --data <strips dir> --train T03,T04,... --val T26,T28 --out det.onnx
"""

import argparse
import json
import os
import random
import time

import numpy as np
import torch
import torch.nn.functional as F

from data import BINS, SH, SLOTS, SW, bin_targets, load_video
from detector import BinsOnly, StripDetector


def collect_neg(neg_dir, keys, every):
    """Strips with the lane moved clear of the RAMP (scratch mkStripsNeg.ts): not a RAMP."""
    out = []
    for k in keys:
        f = os.path.join(neg_dir, f"{k}.json")
        if not os.path.exists(f):
            continue
        n = len(json.load(open(f))["meta"])
        raw = np.memmap(os.path.join(neg_dir, f"{k}.bin"), dtype=np.uint8, mode="r").reshape(n, SH, SW, 3)
        out.append(np.ascontiguousarray(raw[::every]))
        print(f"  {k}: {len(out[-1])} strips off the RAMP", flush=True)
    return np.concatenate(out) if out else np.zeros((0, SH, SW, 3), np.uint8)


def collect(data_dir, keys, every, ramps=None):
    X, T, M, src = [], [], [], []
    for k in keys:
        _, vids = load_video(data_dir, k, every=every)
        for a, d in vids.items():
            if ramps is not None and (k, a) not in ramps:
                continue
            keep = d["ok"] == 1
            lab = d["l"][keep]
            known = (lab != 255).any(axis=1)
            if known.sum() == 0:
                continue
            x, lab = d["x"][keep][known], lab[known]
            t, m = bin_targets(lab)
            X.append(x), T.append(t), M.append(m)
            src += [f"{k}:{'rb'[a]}"] * len(x)
            print(f"  {k} {'red' if a == 0 else 'blue'}: {len(x)} strips, {(lab == 1).sum()} ARTIFACT / {(lab == 0).sum()} empty slots", flush=True)
    return np.concatenate(X), np.concatenate(T), np.concatenate(M), np.array(src)


def sprites_from(X, T, M, n=20000, rng=None):
    """16 x 16 crops of ARTIFACTS resting in their slots (slot centre at 16k + 8 px)."""
    rng = rng or np.random.default_rng(0)
    out = []
    peaks = [(i, k) for k in range(SLOTS) for i in np.where(T[:, 4 * k + 1] > 0.5)[0]]
    rng.shuffle(peaks)
    for i, k in peaks[:n]:
        out.append(X[i, 12:28, 16 * k:16 * k + 16])
    return np.stack(out) if out else np.zeros((0, 16, 16, 3), np.uint8)


_yy, _xx = np.mgrid[0:16, 0:16].astype(np.float32) + 0.5
_alpha = np.clip((7.6 - np.hypot(_xx - 8, _yy - 8)) / 1.5 + 0.5, 0, 1)[..., None]


def paste_balls(x, tgt, mask, sprites, rng, p=0.5):
    """Paste 1-3 ARTIFACTS at random positions along known-empty parts of the lane."""
    n = x.shape[0]
    centres = np.arange(BINS, dtype=np.float32)
    for i in range(n):
        if rng.random() > p:
            continue
        for _ in range(rng.integers(1, 4)):
            u = rng.uniform(8, SW - 8)
            b = u / 4 - 0.5
            lo, hi = int(max(0, np.floor(b - 2))), int(min(BINS, np.ceil(b + 3)))
            if mask[i, lo:hi].min() < 1 or tgt[i, lo:hi].max() > 0.1:
                continue
            s = sprites[rng.integers(len(sprites))].astype(np.float32)
            blur = int(rng.choice([0, 0, 2, 4, 6, 8]))
            if blur:
                acc = np.zeros_like(s)
                for d in range(blur + 1):
                    acc += np.roll(s, d - blur // 2, axis=1)
                s = acc / (blur + 1)
                a = np.clip(_alpha * 1.0, 0, 1)
            else:
                a = _alpha
            u0, v0 = int(round(u - 8)), int(round(20 + rng.normal(0, 1.2) - 8))
            u0, v0 = min(max(u0, 0), SW - 16), min(max(v0, 0), SH - 16)
            reg = x[i, v0:v0 + 16, u0:u0 + 16].astype(np.float32)
            x[i, v0:v0 + 16, u0:u0 + 16] = np.clip(a * s + (1 - a) * reg, 0, 255).astype(np.uint8)
            bump = np.exp(-0.5 * ((centres - (u0 + 8) / 4 + 0.5) / 0.8) ** 2)
            tgt[i] = np.maximum(tgt[i], bump)
            mask[i, max(0, lo - 1):min(BINS, hi + 1)] = 1
    return x, tgt, mask


# colours of robots, people and field parts that are not ARTIFACTS (no purple, no green)
_OCC = np.array([[30, 30, 30], [200, 200, 200], [120, 120, 125], [190, 40, 40], [40, 70, 190], [220, 180, 150], [90, 60, 40], [240, 240, 240], [10, 10, 60]], np.float32)


def occlude(x, tgt, mask, rng, p=0.25):
    """Something in front of the RAMP: a textured block of a non-ARTIFACT colour. The bins it
    covers have no visible ARTIFACT (target 0)."""
    n = x.shape[0]
    for i in range(n):
        if rng.random() > p:
            continue
        w = int(rng.integers(8, 48))
        u0 = int(rng.integers(0, SW - w))
        h0, h1 = sorted(rng.integers(0, SH, 2))
        h0, h1 = min(h0, 8), max(h1, 32)
        c = _OCC[rng.integers(len(_OCC))] + rng.normal(0, 15, 3)
        tex = c[None, None, :] + rng.normal(0, 12, (h1 - h0, w, 1))
        x[i, h0:h1, u0:u0 + w] = np.clip(tex, 0, 255).astype(np.uint8)
        b0, b1 = u0 // 4, min(BINS, (u0 + w + 3) // 4)
        tgt[i, b0:b1] = 0
        mask[i, b0:b1] = 1
    return x, tgt, mask


ACROSS_SHIFT_PX = 3.2  # lane found off across by up to this (8 px = 1 ball radius)


def photometric(xb):
    """N x 3 x H x W in 0..1 on the device: lighting and camera changes, lane found slightly off."""
    n, dev = xb.shape[0], xb.device
    # lane off across (ACROSS_SHIFT_PX) and by +-2 px along, scale +-10 %
    theta = torch.zeros(n, 2, 3, device=dev)
    s = 1 + (torch.rand(n, device=dev) - 0.5) * 0.2
    theta[:, 0, 0] = s
    theta[:, 1, 1] = s
    shift_u = (torch.rand(n, device=dev) - 0.5) * 2 * 2.0  # px
    theta[:, 0, 2] = shift_u / (SW / 2)
    theta[:, 1, 2] = (torch.rand(n, device=dev) - 0.5) * 2 * (ACROSS_SHIFT_PX / (SH / 2))
    grid = F.affine_grid(theta, xb.shape, align_corners=False)
    xb = F.grid_sample(xb, grid, padding_mode="border", align_corners=False)
    b = (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.4
    c = 1 + (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.6
    grey = xb.mean(dim=1, keepdim=True)
    sat = 1 + (torch.rand(n, 1, 1, 1, device=dev) - 0.5) * 0.8
    xb = grey + (xb - grey) * sat
    xb = (xb - 0.5) * c + 0.5 + b
    # white balance
    xb = xb * (1 + (torch.rand(n, 3, 1, 1, device=dev) - 0.5) * 0.12)
    k = torch.tensor([1.0, 2.0, 1.0], device=dev)
    k = (k[:, None] * k[None, :]) / 16
    blur = F.conv2d(F.pad(xb, (1, 1, 1, 1), mode="replicate"), k.expand(3, 1, 3, 3), groups=3)
    m = (torch.rand(n, 1, 1, 1, device=dev) < 0.35).float()
    xb = m * blur + (1 - m) * xb
    # a small RAMP in a low-resolution video (240p-360p): the lane had a few px per ARTIFACT
    lo = torch.rand(n, device=dev) < 0.3
    if lo.any():
        f = float(np.random.uniform(1.5, 3.5))
        small = F.interpolate(xb[lo], scale_factor=1 / f, mode="area")
        xb[lo] = F.interpolate(small, size=xb.shape[2:], mode="bilinear", align_corners=False)
    xb = xb + torch.randn_like(xb) * (torch.rand(n, 1, 1, 1, device=dev) * 0.05)
    return xb.clamp(0, 1), shift_u, s


def shift_targets(t, m, shift_u, scale):
    """Targets follow the along-lane shift / scale of photometric() (sample grid: x_in = s*x_out + d)."""
    n = t.shape[0]
    pos = (torch.arange(BINS, device=t.device).float() + 0.5) * 4  # px, output bin centres
    centre = SW / 2
    src = (pos[None, :] - centre) * scale[:, None] + centre + shift_u[:, None]  # input px for each output bin
    sb = (src / 4 - 0.5).clamp(0, BINS - 1)
    i0 = sb.floor().long()
    i1 = (i0 + 1).clamp(max=BINS - 1)
    w = sb - i0.float()
    tt = t.gather(1, i0) * (1 - w) + t.gather(1, i1) * w
    mm = torch.minimum(m.gather(1, i0), m.gather(1, i1))
    return tt, mm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", default="")
    ap.add_argument("--neg", default="", help="dir of strips off the RAMP (not a RAMP)")
    ap.add_argument("--ramps", default="", help="only these RAMPs, e.g. T03:r,T03:b,T05:r (default: all)")
    ap.add_argument("--every", type=int, default=2)
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--out", default="detector.onnx")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--across_shift", type=float, default=3.2, help="px; the strip has 8 px per ball radius")
    a = ap.parse_args()
    global ACROSS_SHIFT_PX
    ACROSS_SHIFT_PX = a.across_shift
    random.seed(a.seed), np.random.seed(a.seed), torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ramps = None
    if a.ramps:
        ramps = {(r.split(":")[0], "rb".index(r.split(":")[1])) for r in a.ramps.split(",")}
    print("train:")
    X, T, M, S = collect(a.data, a.train.split(","), a.every, ramps)
    print(f"train: {len(X)} strips; ARTIFACT bins {(T > 0.5).sum()}, known bins {M.sum():.0f}")
    Xv = Tv = Mv = None
    if a.val:
        print("val:")
        Xv, Tv, Mv, Sv = collect(a.data, a.val.split(","), 3, None)
    Xn = collect_neg(a.neg, sorted({k for k, _ in ramps} if ramps else a.train.split(",")), max(1, a.every // 2)) if a.neg else np.zeros((0, SH, SW, 3), np.uint8)
    Xnv = collect_neg(a.neg, a.val.split(","), 2) if a.neg and a.val else np.zeros((0, SH, SW, 3), np.uint8)
    print(f"{len(Xn)} strips off the RAMP for training, {len(Xnv)} held out")
    sprites = sprites_from(X, T, M, rng=rng)
    print(f"{len(sprites)} ARTIFACT sprites for pasting")
    net = StripDetector().to(dev)
    print(f"{sum(p.numel() for p in net.parameters())} parameters")
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    B = 256
    steps = a.epochs * (len(X) // B + 1)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)

    def evaluate():
        net.eval()
        tp = fp = fn = tn = 0
        ramp_pos = ramp_neg = 0
        with torch.no_grad():
            for i in range(0, len(Xnv), 1024):
                xb = torch.from_numpy(Xnv[i:i + 1024]).to(dev).permute(0, 3, 1, 2).float() / 255
                ramp_neg += int((net(xb)[1] < 0).sum())
            for i in range(0, len(Xv), 1024):
                xb = torch.from_numpy(Xv[i:i + 1024]).to(dev).permute(0, 3, 1, 2).float() / 255
                bins, ramp = net(xb)
                ramp_pos += int((ramp > 0).sum())
                p = torch.sigmoid(bins).cpu().numpy()
                # per slot: the strongest bin of the slot, against the slot label
                ps = p.reshape(-1, SLOTS, 4).max(axis=2)
                ts = Tv[i:i + 1024].reshape(-1, SLOTS, 4).max(axis=2)
                ms = Mv[i:i + 1024].reshape(-1, SLOTS, 4).min(axis=2)
                pos, neg = (ts > 0.5) & (ms > 0), (ts < 0.1) & (ms > 0)
                tp += int(((ps > 0.5) & pos).sum())
                fn += int(((ps <= 0.5) & pos).sum())
                fp += int(((ps > 0.5) & neg).sum())
                tn += int(((ps <= 0.5) & neg).sum())
        net.train()
        return tp, fp, fn, tn, ramp_pos / max(1, len(Xv)), ramp_neg / max(1, len(Xnv))

    t0 = time.time()
    for ep in range(a.epochs):
        perm = rng.permutation(len(X))
        tot, nb = 0.0, 0
        for bi in range(0, len(X), B):
            idx = np.sort(perm[bi:bi + B])
            x = X[idx].copy()
            t, m = T[idx].copy(), M[idx].copy()
            if rng.random() < 0.5:  # along-lane flip (the detector is local)
                x, t, m = x[:, :, ::-1].copy(), t[:, ::-1].copy(), m[:, ::-1].copy()
            if rng.random() < 0.5:  # across flip: which side of the lane is "up" depends on the view
                x = x[:, ::-1].copy()
            x, t, m = paste_balls(x, t, m, sprites, rng)
            x, t, m = occlude(x, t, m, rng)
            # a quarter as many strips off the RAMP: their ARTIFACTS (balls on the floor) are not
            # labelled, only that they are not a RAMP
            nn_ = len(idx) // 4 if len(Xn) else 0
            if nn_:
                xn = Xn[rng.integers(0, len(Xn), nn_)].copy()
                if rng.random() < 0.5:
                    xn = xn[:, :, ::-1].copy()
                if rng.random() < 0.5:
                    xn = xn[:, ::-1].copy()
                x = np.concatenate([x, xn])
                t = np.concatenate([t, np.zeros((nn_, BINS), np.float32)])
                m = np.concatenate([m, np.zeros((nn_, BINS), np.float32)])
            is_ramp = torch.cat([torch.ones(len(idx)), torch.zeros(nn_)]).to(dev)
            xb = torch.from_numpy(x).to(dev).permute(0, 3, 1, 2).float() / 255
            tb, mb = torch.from_numpy(t).to(dev), torch.from_numpy(m).to(dev)
            xb, su, sc = photometric(xb)
            tb, mb = shift_targets(tb, mb, su, sc)
            logit, ramp_logit = net(xb)
            loss = (F.binary_cross_entropy_with_logits(logit, tb, reduction="none", pos_weight=torch.tensor(3.0, device=dev)) * mb).sum() / mb.sum().clamp(min=1)
            if nn_:
                loss = loss + 0.5 * F.binary_cross_entropy_with_logits(ramp_logit, is_ramp)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += float(loss.detach())
            nb += 1
        msg = f"epoch {ep + 1}/{a.epochs}: loss {tot / max(1, nb):.4f} ({time.time() - t0:.0f} s)"
        if Xv is not None:
            tp, fp, fn, tn, rp, rn = evaluate()
            msg += f" | held-out slots: ARTIFACT recall {tp / max(1, tp + fn):.3f}, empty kept empty {tn / max(1, tn + fp):.3f} (tp {tp} fn {fn} fp {fp} tn {tn}) | RAMP strips seen as RAMP {rp:.3f}, strips off the RAMP seen as not {rn:.3f}"
        print(msg, flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sd = net.state_dict()
    if not len(Xn):  # no strips off the RAMP: the RAMP output was never trained and is left out
        sd = {k: v for k, v in sd.items() if not k.startswith("ramp.")}
    torch.save(sd, os.path.splitext(a.out)[0] + ".pt")
    net.eval().cpu()
    if len(Xn):
        torch.onnx.export(net, torch.zeros(1, 3, SH, SW), a.out, input_names=["strip"], output_names=["bins", "ramp"], dynamic_axes={"strip": {0: "n"}, "bins": {0: "n"}, "ramp": {0: "n"}}, opset_version=17, dynamo=False)
    else:
        torch.onnx.export(BinsOnly(net), torch.zeros(1, 3, SH, SW), a.out, input_names=["strip"], output_names=["bins"], dynamic_axes={"strip": {0: "n"}, "bins": {0: "n"}}, opset_version=17, dynamo=False)
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
