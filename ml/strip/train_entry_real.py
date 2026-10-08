"""Train the entry counter on real matches, with the scorekeepers' count as the target.

On a broadcast the score bar shows the scorekeepers' CLASSIFIED count over the match (read by
lib/scouting/scoreboard.ts). The scorekeepers enter an ARTIFACT when they see it come onto the
RAMP: from about LEAD s before it reaches the counter's view (they watch the GOAL) to LAG s after
(they type). So at any time t the number of ARTIFACTS that have come onto the RAMP lies between
the bar's count at t - LEAD and at t + LAG. The counter's running count is kept in that band
(squared hinge), which needs no frame-exact labels.

Matches are split by video: --val lists videos that are only counted, never trained on.

  python train_entry_real.py --q <q dir> --bar <dir with sbAll_<key>.json> --ramps T03:r,... --val T14,T28 --out entry.pt
"""

import argparse
import json
import os
import random

import numpy as np
import torch
import torch.nn.functional as F

from entry_model import EntryNet

LEAD, LAG, SETTLE = 1.0, 4.0, 3.0
# whether frames the detector does not take for a RAMP count as unseen (measured: on views it was
# not trained on it also turned real RAMPS away, so off by default)
USE_RAMP = False
REPORT_EVERY = 1000
FPS = 15


def official_steps(bar_file, al):
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


def step_fn(steps):
    ts = np.array([s[0] for s in steps], np.float64)
    vs = np.array([s[1] for s in steps], np.float64)

    def C(t):
        i = np.searchsorted(ts, t, side="right") - 1
        return np.where(i >= 0, vs[np.clip(i, 0, None)], 0.0)

    return C


def load_ramp(qdir, bardir, key, al):
    d = np.load(os.path.join(qdir, f"{key}.npz"))
    # a low-resolution rendition (T03_360p) has the score bar of its video (T03)
    base = key.split("_")[0]
    bar = json.load(open(os.path.join(bardir, f"sbAll_{base}.json")))
    w = bar["window"]
    steps = official_steps(os.path.join(bardir, f"sbAll_{base}.json"), al)
    t, q, ok = d[f"{al}_t"].astype(np.float64), d[f"{al}_q"], d[f"{al}_ok"].astype(np.float32)
    if USE_RAMP and f"{al}_ramp" in d:  # seen as a RAMP
        ok = ok * (d[f"{al}_ramp"] > 0.5)
    keep = (t >= w["start"] - 2) & (t <= w["buzzer"] + SETTLE)
    q = q * ok[:, None]  # as the app does: no response where the RAMP was not followed
    return {"key": key, "al": al, "t": t[keep], "q": q[keep].astype(np.float32), "ok": ok[keep], "C": step_fn(steps), "final": steps[-1][1], "start": w["start"], "end": w["buzzer"] + SETTLE}


def load_zero(qdir, key, al):
    """A lane that is not on a RAMP (placement put it beside the RAMP, on a wall, off the
    picture): whatever passes through it, nothing ever comes onto a RAMP there."""
    d = np.load(os.path.join(qdir, f"{key}.npz"))
    t, q, ok = d[f"{al}_t"].astype(np.float64), d[f"{al}_q"], d[f"{al}_ok"].astype(np.float32)
    if USE_RAMP and f"{al}_ramp" in d:
        ok = ok * (d[f"{al}_ramp"] > 0.5)
    q = (q * ok[:, None]).astype(np.float32)
    return {"key": key, "al": al, "t": t, "q": q, "ok": ok, "C": lambda x: np.zeros_like(np.asarray(x, np.float64)), "final": 0, "start": float(t[0]), "end": float(t[-1])}


def crop(r, rng, min_s=20, max_s=120):
    n = len(r["t"])
    L = int(min(n, rng.uniform(min_s, max_s) * FPS))
    a = rng.integers(0, max(1, n - L + 1))
    return a, a + L


def augment(q, ok, rng):
    q = q.copy()
    ok = ok.copy()
    q = np.clip(q, 0, 1) ** rng.uniform(0.7, 1.4)
    q = np.clip(q + rng.normal(0, rng.uniform(0, 0.04), q.shape), 0, 1)
    drop = rng.random(len(q)) < rng.choice([0.0, 0.0, 0.1, 0.25])
    q[drop] = 0
    ok[drop] = 0
    hide = int(rng.choice([0, 0, 0, 2, 4, 6]))
    if hide:
        q[:, -hide:] = 0
    s = int(rng.choice([-1, 0, 0, 1]))
    if s:
        q = np.roll(q, s, axis=1)
        if s > 0:
            q[:, :s] = 0
        else:
            q[:, s:] = 0
    return q.astype(np.float32), ok


def batch_loss(net, items, dev):
    """items: list of (q, ok, lower, upper) arrays; padded to the longest."""
    L = max(len(i[0]) for i in items)
    n = len(items)
    x = torch.zeros(n, 2, L, 36, device=dev)
    lo = torch.zeros(n, L, device=dev)
    hi = torch.zeros(n, L, device=dev)
    m = torch.zeros(n, L, device=dev)
    for k, (q, ok, lower, upper) in enumerate(items):
        T = len(q)
        x[k, 0, :T] = torch.from_numpy(q).to(dev)
        x[k, 1, :T] = torch.from_numpy(ok).to(dev)[:, None]
        lo[k, :T] = torch.from_numpy(lower).to(dev)
        hi[k, :T] = torch.from_numpy(upper).to(dev)
        m[k, :T] = 1
    lam = net(x) * m
    cum = torch.cumsum(lam, 1)
    loss = ((F.relu(lo - cum) ** 2 + F.relu(cum - hi) ** 2) * m).sum() / m.sum()
    return loss


def bands(r, a, b, scale=1.0):
    t = r["t"][a:b]
    ta = t[0]
    lower = np.maximum(0, r["C"](t - LEAD) - r["C"](np.array([ta + LAG]))[0])
    upper = np.maximum(0, r["C"](t + LAG) - r["C"](np.array([ta - LEAD]))[0])
    return lower.astype(np.float32), upper.astype(np.float32)


def evaluate(net, ramps, dev):
    net.eval()
    out = []
    with torch.no_grad():
        for r in ramps:
            x = torch.zeros(1, 2, len(r["q"]), 36, device=dev)
            x[0, 0] = torch.from_numpy(r["q"]).to(dev)
            x[0, 1] = torch.from_numpy(r["ok"]).to(dev)[:, None]
            lam = net(x)[0].cpu().numpy()
            win = (r["t"] >= r["start"]) & (r["t"] <= r["end"])
            out.append((r["key"], r["al"], float(lam[win].sum()), r["final"]))
    net.train()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", required=True)
    ap.add_argument("--bar", required=True)
    ap.add_argument("--ramps", required=True)
    ap.add_argument("--val", default="")
    ap.add_argument("--zero_ramps", default="", help="lanes not on a RAMP: nothing comes on there (count 0)")
    ap.add_argument("--use_ramp", action="store_true", help="frames not taken for a RAMP are unseen")
    ap.add_argument("--init", default="")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--out", default="entry_real.pt")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    global USE_RAMP
    USE_RAMP = a.use_ramp
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    val = set(a.val.split(",")) if a.val else set()
    ramps = [load_ramp(a.q, a.bar, r.split(":")[0], "red" if r.split(":")[1] == "r" else "blue") for r in a.ramps.split(",")]
    # held-out videos: all their renditions
    train = [r for r in ramps if r["key"].split("_")[0] not in val]
    test = [r for r in ramps if r["key"].split("_")[0] in val]
    if a.zero_ramps:
        zeros = [load_zero(a.q, r.split(":")[0], "red" if r.split(":")[1] == "r" else "blue") for r in a.zero_ramps.split(",")]
        train += [z for z in zeros if z["key"].split("_")[0] not in val]
        test += [z for z in zeros if z["key"].split("_")[0] in val]
    print(f"train {len(train)} RAMPs ({sum(r['final'] for r in train)} official CLASSIFIED), test {len(test)} RAMPs ({sum(r['final'] for r in test)})")
    net = EntryNet().to(dev)
    if a.init:
        net.load_state_dict(torch.load(a.init, map_location=dev))
    opt = torch.optim.AdamW(net.parameters(), lr=5e-4, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.steps)

    def report(tag):
        for name, rs in (("train", train), ("test", test)):
            if not rs:
                continue
            res = evaluate(net, rs, dev)
            err = sum(abs(g - o) for _, _, g, o in res)
            tot = sum(o for _, _, _, o in res)
            print(f"  {tag} {name}: |error| {err:.0f} of {tot} ({100 * err / max(1, tot):.1f}%): " + ", ".join(f"{k}{al[0]} {g:.0f}/{o}" for k, al, g, o in res), flush=True)

    report("start")
    for step in range(a.steps):
        items = []
        for _ in range(8):
            r = train[rng.integers(len(train))]
            s, e = crop(r, rng)
            q, ok = augment(r["q"][s:e], r["ok"][s:e], rng)
            lower, upper = bands(r, s, e)
            items.append((q, ok, lower, upper))
        loss = batch_loss(net, items, dev)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
        if (step + 1) % REPORT_EVERY == 0:
            print(f"step {step + 1}: band loss {float(loss.detach()):.3f}")
            report(f"step {step + 1}")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    torch.save(net.state_dict(), a.out)
    print("saved", a.out)


if __name__ == "__main__":
    main()
