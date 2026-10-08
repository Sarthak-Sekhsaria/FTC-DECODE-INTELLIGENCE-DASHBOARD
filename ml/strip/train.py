"""Train the RAMP strip model: for each of the 9 slots of a RAMP strip, is an ARTIFACT there?

A strip is the RAMP's lane cut out of a frame and straightened (scratch tool mkStrips.ts in the
app repo's history; the app cuts it the same way): 9 slots along it, PX = 16 px per slot, and
+-2.5 ball radii across it, so 144 x 40 px RGB. Labels per slot: 1 = ARTIFACT, 0 = empty,
255 = not labelled (the label generator only labels slots where two independent signals agree).

Usage (training environment, outside OneDrive):
  python train.py --data %LOCALAPPDATA%\\ArtifactIQ\\data\\strips --out strip.onnx [--val T03,T14,T25]

The model is small (~100k parameters) so it runs in a browser for every frame. Validation is
on whole held-out videos, never on strips from videos it trained on.
"""

import argparse
import json
import os
import random

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

SLOTS, PX, SH = 9, 16, 40
SW = SLOTS * PX


def load(data_dir, keys):
    xs, ys, ks = [], [], []
    for k in keys:
        meta = json.load(open(os.path.join(data_dir, f"{k}.json")))
        raw = np.fromfile(os.path.join(data_dir, f"{k}.bin"), dtype=np.uint8)
        n = len(meta["meta"])
        x = raw.reshape(n, SH, SW, 3)
        y = np.array([m["labels"] for m in meta["meta"]], dtype=np.uint8)
        keep = (y != 255).any(axis=1)
        xs.append(x[keep])
        ys.append(y[keep])
        ks += [k] * int(keep.sum())
    return np.concatenate(xs), np.concatenate(ys), np.array(ks)


class StripNet(nn.Module):
    """Conv stack over the strip; height pooled away; two positions per slot averaged."""

    def __init__(self, w=32):
        super().__init__()

        def block(cin, cout):
            return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True), nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))

        self.b1, self.b2, self.b3 = block(3, w // 2), block(w // 2, w), block(w, 2 * w)
        self.head = nn.Sequential(nn.Conv1d(2 * w, 2 * w, 3, padding=1), nn.ReLU(inplace=True), nn.Conv1d(2 * w, 1, 1))

    def forward(self, x):  # x: N x 3 x 40 x 144, 0..1
        x = F.max_pool2d(self.b1(x), 2)  # 20 x 72
        x = F.max_pool2d(self.b2(x), 2)  # 10 x 36
        x = F.max_pool2d(self.b3(x), 2)  # 5 x 18
        x = x.amax(dim=2)  # N x C x 18 (strongest response across the lane)
        x = self.head(x)  # N x 1 x 18
        return F.avg_pool1d(x, 2).squeeze(1)  # N x 9 slot logits


def augment(x, rng):
    """x: N x 3 x H x W float tensor on the device. Simulates a RAMP found slightly off, other
    lighting and cameras, and things in front of the RAMP."""
    n = x.shape[0]
    # shift across (+-6 px = +-0.75 radius) and along (+-3 px), scale +-12 %
    theta = torch.zeros(n, 2, 3, device=x.device)
    s = 1 + (torch.rand(n, device=x.device) - 0.5) * 0.24
    theta[:, 0, 0] = s
    theta[:, 1, 1] = s * (1 + (torch.rand(n, device=x.device) - 0.5) * 0.2)
    theta[:, 0, 2] = (torch.rand(n, device=x.device) - 0.5) * 2 * (3 / (SW / 2))
    theta[:, 1, 2] = (torch.rand(n, device=x.device) - 0.5) * 2 * (6 / (SH / 2))
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    x = F.grid_sample(x, grid, padding_mode="border", align_corners=False)
    # brightness / contrast / saturation (no hue change: purple and green must stay apart)
    b = (torch.rand(n, 1, 1, 1, device=x.device) - 0.5) * 0.4
    c = 1 + (torch.rand(n, 1, 1, 1, device=x.device) - 0.5) * 0.6
    grey = x.mean(dim=1, keepdim=True)
    sat = 1 + (torch.rand(n, 1, 1, 1, device=x.device) - 0.5) * 0.6
    x = grey + (x - grey) * sat
    x = (x - 0.5) * c + 0.5 + b
    # blur some
    k = torch.tensor([1.0, 2.0, 1.0], device=x.device)
    k = (k[:, None] * k[None, :]) / 16
    blur = F.conv2d(F.pad(x, (1, 1, 1, 1), mode="replicate"), k.expand(3, 1, 3, 3), groups=3)
    m = (torch.rand(n, 1, 1, 1, device=x.device) < 0.4).float()
    x = m * blur + (1 - m) * x
    # sensor noise
    x = x + torch.randn_like(x) * (torch.rand(n, 1, 1, 1, device=x.device) * 0.04)
    return x.clamp(0, 1)


def occlude(x, y, rng):
    """Paste a random patch of another strip over part of some strips (a person or robot in
    front): the slots it covers lose their label."""
    n = x.shape[0]
    y = y.clone()
    for i in range(n):
        if rng.random() > 0.3:
            continue
        j = rng.randrange(n)
        w = rng.randrange(PX, 4 * PX)
        u0 = rng.randrange(0, SW - w)
        x[i, :, :, u0 : u0 + w] = x[j, :, :, u0 : u0 + w].flip(-1)
        s0, s1 = max(0, (u0 - PX // 2) // PX), min(SLOTS, (u0 + w + PX // 2) // PX + 1)
        y[i, s0:s1] = 255
    return x, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--train", default="")
    ap.add_argument("--val", default="")
    ap.add_argument("--out", default="strip.onnx")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    random.seed(a.seed)
    np.random.seed(a.seed)
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    keys = a.train.split(",") if a.train else sorted(f[:-5] for f in os.listdir(a.data) if f.endswith(".json"))
    val = [k for k in a.val.split(",") if k]
    tr = [k for k in keys if k not in val]
    xtr, ytr, _ = load(a.data, tr)
    print(f"train: {len(xtr)} strips from {len(tr)} videos; ARTIFACT slots {(ytr == 1).sum()}, empty {(ytr == 0).sum()}")
    xva = yva = None
    if val:
        xva, yva, _ = load(a.data, val)
        print(f"val: {len(xva)} strips from {len(val)} videos; ARTIFACT slots {(yva == 1).sum()}, empty {(yva == 0).sum()}")
    net = StripNet().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = a.epochs * (len(xtr) // 256 + 1)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    # balance: ARTIFACT slots are rarer than empty ones
    pos = (ytr == 1).sum()
    neg = (ytr == 0).sum()
    pw = torch.tensor(float(neg) / max(1.0, float(pos)), device=dev).clamp(max=5.0)
    xt = torch.from_numpy(xtr)
    yt = torch.from_numpy(ytr)

    def evaluate():
        net.eval()
        stats = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
        with torch.no_grad():
            for i in range(0, len(xva), 512):
                xb = torch.from_numpy(xva[i : i + 512]).to(dev).permute(0, 3, 1, 2).float() / 255
                p = torch.sigmoid(net(xb)).cpu().numpy() > 0.5
                yb = yva[i : i + 512]
                stats["tp"] += int(((yb == 1) & p).sum())
                stats["fn"] += int(((yb == 1) & ~p).sum())
                stats["fp"] += int(((yb == 0) & p).sum())
                stats["tn"] += int(((yb == 0) & ~p).sum())
        net.train()
        s = stats
        acc = (s["tp"] + s["tn"]) / max(1, sum(s.values()))
        rec = s["tp"] / max(1, s["tp"] + s["fn"])
        prec = s["tp"] / max(1, s["tp"] + s["fp"])
        return acc, prec, rec, s

    for ep in range(a.epochs):
        perm = torch.randperm(len(xt))
        tot = 0.0
        for bi in range(0, len(xt), 256):
            idx = perm[bi : bi + 256]
            xb = xt[idx].to(dev).permute(0, 3, 1, 2).float() / 255
            yb = yt[idx].to(dev).clone()
            xb, yb = occlude(xb, yb, rng)
            xb = augment(xb, rng)
            logit = net(xb)
            mask = yb != 255
            if mask.sum() == 0:
                continue
            loss = F.binary_cross_entropy_with_logits(logit[mask], (yb[mask] == 1).float(), pos_weight=pw)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += float(loss) * len(idx)
        msg = f"epoch {ep + 1}/{a.epochs}: loss {tot / len(xt):.4f}"
        if xva is not None:
            acc, prec, rec, s = evaluate()
            msg += f" | held-out videos: accuracy {acc:.4f}, precision {prec:.4f}, recall {rec:.4f} ({s})"
        print(msg, flush=True)
    net.eval().cpu()
    dummy = torch.zeros(1, 3, SH, SW)
    torch.onnx.export(net, dummy, a.out, input_names=["strip"], output_names=["slot_logits"], dynamic_axes={"strip": {0: "n"}, "slot_logits": {0: "n"}}, opset_version=17)
    print(f"saved {a.out} ({os.path.getsize(a.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
