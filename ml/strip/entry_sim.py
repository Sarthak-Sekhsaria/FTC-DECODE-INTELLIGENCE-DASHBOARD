"""Simulated RAMP timelines for training the entry counter.

What a RAMP does (CM 9.8): ARTIFACTS scored through the SQUARE come onto the top of the RAMP
(slot 8 end) and roll down it, to the GATE when it is open (they leave the RAMP) or onto the
queue held by the closed GATE (slot 0 up). The RAMP holds 9: while slot 8 is taken, a new
ARTIFACT cannot come on (OVERFLOW, not counted here). Robots shoot in bursts of up to 3. A robot
opens the GATE from time to time and the queue rolls out from the bottom.

The counter does not see the ARTIFACTS, only the strip detector's output: per frame, the
probability that an ARTIFACT is centred in each of 36 bins along the lane (bin 4k + 1.5 = slot
k). So the simulation renders that output with the detector's failure modes: weaker and wider
responses on rolling (blurred) ARTIFACTS, missed frames, false responses on robots and people in
front of the RAMP, a top part of the RAMP hidden behind the GOAL in some views, frames where the
RAMP is not tracked, and dropped frames.

Labels: the frames ARTIFACTS came onto the RAMP (each one CLASSIFIED).
"""

import numpy as np

FPS = 15
BINS = 36
SLOTS = 9


def simulate(T, rng):
    """One RAMP for T frames. Returns q (T x 36 float32), valid (T,), entries (frame indices)."""
    dt = 1.0 / FPS
    # --- the match: how this alliance plays ---
    rate = rng.choice([0.02, 0.06, 0.12, 0.25, 0.4, 0.6])  # bursts per second
    burst_p = rng.dirichlet([1, 1, 2])  # P(1), P(2), P(3) balls per burst
    gap = rng.uniform(0.12, 0.5)  # s between balls of a burst
    gate_rate = rng.choice([0.0, 0.02, 0.05, 0.1])  # GATE openings per second
    hold_open = rng.uniform(0.6, 4.0)  # s
    v0, acc, vmax = rng.uniform(1.0, 5.0), rng.uniform(2.0, 14.0), rng.uniform(6.0, 16.0)  # slots/s
    # --- what the detector makes of it ---
    amp_static = rng.uniform(0.55, 1.0)
    amp_moving = rng.uniform(0.3, 1.0)
    width = rng.uniform(0.7, 2.2)  # bins (sigma): a queue reads as separate peaks or as one block
    miss = rng.uniform(0.0, 0.25)  # per ball per frame
    noise = rng.uniform(0.0, 0.08)
    hidden_top = int(rng.choice([0, 0, 0, 2, 4, 6, 8, 10]))  # bins hidden behind the GOAL
    fp_rate = rng.choice([0.0, 0.02, 0.05, 0.1])  # false-response episodes per second
    untracked_rate = rng.choice([0.0, 0.0, 0.005, 0.02])  # untracked stretches per second
    drop = rng.choice([0.0, 0.0, 0.1, 0.3])  # dropped frames (a slow device, live)

    queue = []  # slot positions of resting ARTIFACTS (0, 1, ..)
    moving = []  # [pos, vel] rolling down
    leaving = []  # [pos, vel] of a released queue (not counted)
    entries = []
    pending = []  # frame times of ARTIFACTS on their way to the RAMP
    gate_open_until = -1.0
    q = np.zeros((T, BINS), np.float32)
    valid = np.ones(T, np.float32)
    centres = np.arange(BINS, dtype=np.float32)
    fps_ep = []  # false-response episodes: [t0, t1, b0, b1, speed, amp]
    untracked = []
    for t in range(T):
        now = t * dt
        # new bursts
        if rng.random() < rate * dt:
            k = rng.choice([1, 2, 3], p=burst_p)
            for i in range(k):
                pending.append(now + i * gap * rng.uniform(0.7, 1.3))
        # the GATE
        if gate_open_until < now and queue and rng.random() < gate_rate * dt * (1 + len(queue) / 3):
            gate_open_until = now + hold_open * rng.uniform(0.5, 1.5)
        gate_open = now < gate_open_until
        if gate_open and queue:
            # the whole queue starts rolling out together
            for pos in queue:
                leaving.append([pos, rng.uniform(0.0, 1.0)])
            queue = []
        # ARTIFACTS arriving now
        due = [p for p in pending if p <= now]
        pending = [p for p in pending if p > now]
        for _ in due:
            occupied_top = any(p >= 7.6 for p in queue) or any(m[0] >= 7.6 for m in moving)
            if len(queue) >= SLOTS or occupied_top:
                continue  # OVERFLOW: never on the RAMP
            moving.append([8.4, v0])
            entries.append(t)
        # rolling
        for m in moving:
            m[1] = min(vmax, m[1] + acc * dt)
            m[0] -= m[1] * dt
        still = []
        for m in moving:
            stop_at = len(queue)
            if not gate_open and m[0] <= stop_at:
                queue.append(float(stop_at))
            elif gate_open and m[0] < -0.8:
                pass  # out through the GATE
            else:
                still.append(m)
        moving = still
        for m in leaving:
            m[1] = min(vmax, m[1] + acc * dt)
            m[0] -= m[1] * dt
        leaving = [m for m in leaving if m[0] > -0.8]
        # --- render the detector's view ---
        row = np.zeros(BINS, np.float32)
        for p in queue:
            if rng.random() > miss:
                row = np.maximum(row, amp_static * rng.uniform(0.8, 1.0) * np.exp(-0.5 * ((centres - (4 * p + 1.5)) / width) ** 2))
        for m in moving + leaving:
            if rng.random() > miss:
                w = width * rng.uniform(1.0, 1.8)
                row = np.maximum(row, amp_moving * rng.uniform(0.6, 1.0) * np.exp(-0.5 * ((centres - (4 * m[0] + 1.5)) / w) ** 2))
        # false responses: something passing in front of the RAMP (or standing there)
        if rng.random() < fp_rate * dt:
            b0 = rng.uniform(0, BINS)
            fps_ep.append([now, now + rng.uniform(0.2, 4.0), b0, rng.uniform(2, 12), rng.uniform(-20, 20), rng.uniform(0.2, 1.0)])
        for e in fps_ep:
            if e[0] <= now <= e[1]:
                c = e[2] + e[4] * (now - e[0])
                lo, hi = int(max(0, c)), int(min(BINS, c + e[3]))
                if hi > lo:
                    row[lo:hi] = np.maximum(row[lo:hi], e[5] * rng.uniform(0.3, 1.0, hi - lo))
        fps_ep = [e for e in fps_ep if e[1] >= now]
        row = np.clip(row + rng.normal(0, noise, BINS), 0, 1)
        if hidden_top:
            row[BINS - hidden_top:] = rng.uniform(0, 0.05, hidden_top)
        # untracked stretches
        if rng.random() < untracked_rate * dt:
            untracked.append([now, now + rng.uniform(0.3, 5.0)])
        if any(a <= now <= b for a, b in untracked) or rng.random() < drop:
            valid[t] = 0
            row[:] = 0
        q[t] = row
    return q, valid, np.array(entries, dtype=np.int64)


def batch(n, T, rng):
    Q = np.zeros((n, T, BINS), np.float32)
    V = np.zeros((n, T), np.float32)
    E = []
    for i in range(n):
        Q[i], V[i], e = simulate(T, rng)
        E.append(e)
    return Q, V, E
