"""Train the entry counter (entry_model.py) on simulated RAMP timelines (entry_sim.py).

Real matches are kept for testing: on broadcasts the score bar gives the scorekeepers' count over
time, and the counter's running count is compared with it there (eval_entry.py).

  python train_entry.py --out entry.onnx [--sequences 20000] [--frames 300]
"""

import argparse
import multiprocessing as mp
import os
import time

import numpy as np
import torch
import torch.nn.functional as F

from entry_model import EntryNet
from entry_sim import BINS, simulate


def _gen(args):
    seed, n, T = args
    rng = np.random.default_rng(seed)
    Q = np.zeros((n, T, BINS), np.float16)
    V = np.zeros((n, T), np.uint8)
    Y = np.zeros((n, T), np.float32)  # entries per frame
    for i in range(n):
        q, v, e = simulate(T, rng)
        Q[i], V[i] = q, v
        for f in e:
            Y[i, f] += 1
    return Q, V, Y


def make(n, T, seed, workers):
    per = max(1, n // (workers * 4))
    jobs = [(seed * 100000 + k, per, T) for k in range((n + per - 1) // per)]
    with mp.Pool(workers) as pool:
        parts = pool.map(_gen, jobs)
    Q = np.concatenate([p[0] for p in parts])[:n]
    V = np.concatenate([p[1] for p in parts])[:n]
    Y = np.concatenate([p[2] for p in parts])[:n]
    return Q, V, Y


def density(y, sigma=1.5):
    """Entries per frame -> a smooth density with the same total (Gaussian, sigma frames)."""
    r = int(3 * sigma)
    k = torch.exp(-0.5 * (torch.arange(-r, r + 1, device=y.device).float() / sigma) ** 2)
    k = (k / k.sum()).view(1, 1, -1)
    return F.conv1d(y.unsqueeze(1), k, padding=r).squeeze(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="entry.onnx")
    ap.add_argument("--sequences", type=int, default=20000)
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    Q, V, Y = make(a.sequences, a.frames, a.seed, a.workers)
    Qv, Vv, Yv = make(1000, a.frames * 4, a.seed + 7, a.workers)
    print(f"simulated {len(Q)} training and {len(Qv)} test timelines in {time.time() - t0:.0f} s; entries per training timeline {Y.sum(1).mean():.1f}", flush=True)
    net = EntryNet().to(dev)
    print(f"{sum(p.numel() for p in net.parameters())} parameters")
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
    B = 64
    steps = a.epochs * (len(Q) // B)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=steps)

    def inp(q, v):
        q = torch.from_numpy(q.astype(np.float32)).to(dev)
        v = torch.from_numpy(v.astype(np.float32)).to(dev)
        return torch.stack([q, v.unsqueeze(2).expand_as(q)], 1)

    def test():
        net.eval()
        errs, tot = [], []
        with torch.no_grad():
            for i in range(0, len(Qv), 32):
                lam = net(inp(Qv[i:i + 32], Vv[i:i + 32])).cpu().numpy()
                errs += list(lam.sum(1) - Yv[i:i + 32].sum(1))
                tot += list(Yv[i:i + 32].sum(1))
        net.train()
        errs, tot = np.array(errs), np.array(tot)
        return np.abs(errs).mean(), errs.mean(), np.abs(errs).sum() / max(1, tot.sum()), np.percentile(np.abs(errs), 95)

    for ep in range(a.epochs):
        perm = np.random.default_rng(ep).permutation(len(Q))
        tl = 0.0
        for bi in range(0, len(Q) - B + 1, B):
            idx = np.sort(perm[bi:bi + B])
            x = inp(Q[idx], V[idx])
            y = torch.from_numpy(Y[idx]).to(dev)
            lam = net(x)
            d = density(y)
            # Poisson likelihood of the counts over short stretches (0.4 s and 2 s), and the shape
            loss = F.mse_loss(lam, d) * 20
            for w in (6, 30):
                cl = F.avg_pool1d(lam.unsqueeze(1), w, stride=w // 2).squeeze(1) * w
                cy = F.avg_pool1d(y.unsqueeze(1), w, stride=w // 2).squeeze(1) * w
                loss = loss + F.poisson_nll_loss(cl, cy, log_input=False, eps=1e-4)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tl += float(loss.detach())
        mae, bias, rel, p95 = test()
        print(f"epoch {ep + 1}/{a.epochs}: loss {tl / (len(Q) // B):.4f} | simulated {a.frames * 4 // 15} s test timelines: count error mean {mae:.2f} (bias {bias:+.2f}), {100 * rel:.1f}% of all entries, 95th percentile {p95:.1f} ({time.time() - t0:.0f} s)", flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    torch.save(net.state_dict(), os.path.splitext(a.out)[0] + ".pt")
    net.eval().cpu()
    torch.onnx.export(net, torch.zeros(1, 2, 150, BINS), a.out, input_names=["q"], output_names=["entries"], dynamic_axes={"q": {0: "n", 2: "t"}, "entries": {0: "n", 1: "t"}}, opset_version=17, dynamo=False)
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
