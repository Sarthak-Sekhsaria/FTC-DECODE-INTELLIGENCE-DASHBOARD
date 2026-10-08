"""RAMP strip data for the v2 counter.

A strip is one RAMP's lane cut out of one video frame and straightened (the app cuts it the same
way, lib/scouting/rampStrip.ts): along the lane from slot -0.5 (the GATE end) to slot 8.5 (the
top, where ARTIFACTS come in from the SQUARE) at PX px per slot, and across it +-ACROSS ball
radii, so 144 x 40 px RGB with an ARTIFACT 16 px across. Strips are written per video by the
data tool as <key>.bin (uint8, n x 40 x 144 x 3) + <key>.json (per strip: t, a = alliance
0 red / 1 blue, ok = camera followed, l = 9 slot labels 1 ARTIFACT / 0 empty / 255 unknown).

Positions along the lane are in BINS of PX/4 = 4 px (36 per strip): an ARTIFACT resting in slot
k is centred at bin 4k + 1.5.
"""

import json
import os

import numpy as np

SLOTS, PX, SH = 9, 16, 40
SW = SLOTS * PX
BINS = 36
BIN = SW // BINS  # 4 px


def slot_centre_bin(k):
    return 4 * k + 1.5


def load_video(data_dir, key, every=1, alliances=(0, 1)):
    meta = json.load(open(os.path.join(data_dir, f"{key}.json")))
    m = meta["meta"]
    raw = np.memmap(os.path.join(data_dir, f"{key}.bin"), dtype=np.uint8, mode="r").reshape(len(m), SH, SW, 3)
    out = {}
    for a in alliances:
        idx = [i for i, x in enumerate(m) if x["a"] == a]
        idx = idx[::every]
        if not idx:
            continue
        out[a] = {
            "x": np.ascontiguousarray(raw[idx]),
            "t": np.array([m[i]["t"] for i in idx], dtype=np.float32),
            "ok": np.array([m[i]["ok"] for i in idx], dtype=np.uint8),
            "l": np.array([m[i]["l"] for i in idx], dtype=np.uint8),
        }
    return meta, out


def bin_targets(labels, sigma=0.8):
    """Slot labels (n x 9: 1 / 0 / 255) -> per-bin soft targets and a mask (n x 36).

    An ARTIFACT slot puts a Gaussian bump (peak 1) on its centre bin and marks its 4 bins; an
    empty slot marks its 4 bins with target 0; unknown slots are masked out."""
    n = labels.shape[0]
    tgt = np.zeros((n, BINS), np.float32)
    mask = np.zeros((n, BINS), np.float32)
    centres = np.arange(BINS, dtype=np.float32)
    for k in range(SLOTS):
        lk = labels[:, k]
        known = lk != 255
        mask[known, 4 * k:4 * k + 4] = 1
        ball = lk == 1
        if ball.any():
            bump = np.exp(-0.5 * ((centres - slot_centre_bin(k)) / sigma) ** 2)
            tgt[ball] = np.maximum(tgt[ball], bump[None, :])
    # an ARTIFACT's bump spills into its neighbours' bins: keep those bins known
    return tgt, mask
