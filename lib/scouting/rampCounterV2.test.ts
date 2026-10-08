// The v2 RAMP counter's bookkeeping, with stand-in networks: a "detector" that reads an
// ARTIFACT's position along the lane from the strip, and an "entry counter" that counts an
// ARTIFACT appearing at the top of the lane (a local rule, reach 1 frame, like the real one's
// limited reach). Counting in pieces as frames arrive must give what counting at once gives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_BINS, type RampModels } from "./rampModels.ts";
import { RampCounterV2, V2_FPS } from "./rampCounterV2.ts";

// a strip encoding "ARTIFACT at bin b" (b < 0: none) in its first byte
const strip = (b: number) => {
  const s = new Uint8Array(144 * 40 * 3);
  s[0] = b < 0 ? 255 : b;
  return s;
};

const fake: RampModels = {
  async detect(strips) {
    const q = new Float32Array(strips.length * LANE_BINS);
    // a strip whose second byte is 1 is not a RAMP (the lane landed beside it)
    const ramp = Float32Array.from(strips, (s) => (s[1] === 1 ? 0.1 : 0.9));
    strips.forEach((s, i) => {
      if (s[0] !== 255) q[i * LANE_BINS + s[0]] = 1;
    });
    return { q, ramp };
  },
  async entries(q, valid, T) {
    const lam = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const top = valid[t] ? q[t * LANE_BINS + LANE_BINS - 1] : 0;
      const before = t > 0 && valid[t - 1] ? q[(t - 1) * LANE_BINS + LANE_BINS - 1] : 0;
      lam[t] = top > 0.5 && before < 0.5 ? 1 : 0;
    }
    return lam;
  },
};

// ARTIFACTS rolling down: one comes on (top bin) every `every` frames and takes 12 frames to roll
function scene(frames: number, every: number) {
  const pos: number[] = [];
  for (let f = 0; f < frames; f++) {
    const age = f % every;
    pos.push(age < 12 ? LANE_BINS - 1 - age * 3 : -1);
  }
  return pos;
}

test("v2 counter: counting as frames arrive equals counting at once; windows and events", async () => {
  const pos = scene(600, 30); // 40 s, one ARTIFACT every 2 s -> 20
  const once = new RampCounterV2(fake);
  pos.forEach((b, f) => once.add("red", f / V2_FPS, strip(b)));
  await once.flush();
  const live = new RampCounterV2(fake);
  for (let f = 0; f < pos.length; f++) {
    live.add("red", f / V2_FPS, strip(pos[f]));
    if (f % 17 === 0) await live.flush();
  }
  await live.flush();
  assert.equal(once.count("red", 0, 40), 20);
  assert.equal(live.count("red", 0, 40), 20);
  // a window: ARTIFACTS came on at 0, 2, 4 ... s
  assert.equal(live.count("red", 9.9, 20.1), 6);
  const ev = live.events("red", 0, 40);
  assert.equal(ev.length, 20);
  assert.deepEqual(ev.slice(0, 3).map((e) => e.t), [0, 2, 4]);
  assert.equal(live.count("blue", 0, 40), 0);
});

test("v2 counter: frames where the RAMP was not followed count nothing; a replayed stretch is counted once", async () => {
  const pos = scene(300, 30); // 20 s -> 10
  const c = new RampCounterV2(fake);
  pos.forEach((b, f) => c.add("blue", f / V2_FPS, f >= 60 && f < 90 ? null : strip(b)));
  await c.flush();
  assert.equal(c.count("blue", 0, 20), 9); // the one at 4 s (frame 60) was not seen
  assert.ok(Math.abs(c.seenShare("blue", 0, 20) - 270 / 301) < 0.01);
  // the stretch played again (after a stall): now seen
  for (let f = 60; f < 90; f++) c.add("blue", f / V2_FPS, strip(pos[f]));
  await c.flush();
  assert.equal(c.count("blue", 0, 20), 10);
});

test("v2 counter: live, new strips keep arriving while others are detected — the count still updates", async () => {
  const pos = scene(300, 30); // 20 s -> 10
  let next = 0;
  // a slow detector: while it works, the video plays on and two more frames arrive (into `c`, below)
  const slow: RampModels = {
    async detect(strips) {
      await new Promise((r) => setTimeout(r, 1));
      for (let k = 0; k < 2 && next < pos.length; k++, next++) c.add("red", next / V2_FPS, strip(pos[next]));
      return fake.detect(strips);
    },
    entries: fake.entries,
  };
  const c = new RampCounterV2(slow);
  c.add("red", 0, strip(pos[0]));
  next = 1;
  // the page re-counts about once a second while frames arrive: each re-count finishes while the
  // video is still playing (it does not chase the frames that keep arriving)
  await c.flush();
  assert.ok(next < 10, `the first re-count waited for ${next} frames`);
  for (let i = 0; i < 40 && next < pos.length; i++) {
    await c.flush();
    if (next > 120) assert.ok(c.count("red", 0, 20) >= 3, "counted while playing");
  }
  while (next < pos.length) c.add("red", next / V2_FPS, strip(pos[next++]));
  await c.flush();
  assert.equal(c.count("red", 0, 20), 10);
});

test("v2 counter (useRamp): frames whose strip is not a RAMP are not seen — what shows there is not counted", async () => {
  const pos = scene(300, 30); // 20 s -> 10
  const c = new RampCounterV2(fake, true);
  pos.forEach((b, f) => {
    const s = strip(b);
    if (f >= 60 && f < 90) s[1] = 1; // the lane beside the RAMP for 2 s (the ARTIFACT at 4 s is missed)
    c.add("red", f / V2_FPS, s);
  });
  await c.flush();
  assert.equal(c.count("red", 0, 20), 9);
  assert.ok(Math.abs(c.seenShare("red", 0, 20) - 271 / 301) < 0.01);
});
