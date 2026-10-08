// The match window from field motion (matchClock.ts): synthetic motion series shaped like a
// real match (still before it, AUTO, the still transition, two minutes of TELEOP, people
// walking in to reset the field after it), and the motion measurement on a rendered field.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMatchWindow, FieldMotion, MATCH_SEC, SETTLE_SEC, type MotionSample } from "./matchClock.ts";
import { getFieldModel } from "./placement/fieldModel.ts";
import { intrinsicsFromFov, lookAt, projectPoint, type Vec3 } from "./placement/geometry.ts";
import { initNodeOpenCV, renderField } from "./placement/testing/synthetic.ts";
import type { CameraSolution, Frame } from "./calibration.ts";
import type { CV } from "./placement/cv.ts";

// Motion every 0.2 s: `parts` are [until, level] in order; a little deterministic jitter.
function series(parts: [number, number][], from = 0): MotionSample[] {
  const out: MotionSample[] = [];
  let i = 0;
  for (let t = from; t < parts[parts.length - 1][0]; t += 0.2) {
    while (t >= parts[i][0]) i++;
    out.push({ t, motion: parts[i][1] * (1 + 0.3 * Math.sin(t * 7.3)) });
  }
  return out;
}

// Match starting at 20 s: AUTO 20-50, transition, TELEOP for 120 s, then the field reset.
function match(transition: number, opts: { lull?: boolean } = {}) {
  const teleop = 50 + transition;
  const parts: [number, number][] = [
    [20, 0.001], // robots placed, waiting
    [50, 0.05], // AUTO
    [teleop, 0.002], // transition: robots may not move
  ];
  if (opts.lull) parts.push([teleop + 40, 0.12], [teleop + 44, 0.01], [teleop + 120, 0.12]);
  else parts.push([teleop + 120, 0.12]);
  parts.push([teleop + 127, 0.002], [teleop + 200, 0.2]); // robots stopped, then people resetting the field
  return { samples: series(parts), teleop, buzzer: teleop + 120, duration: teleop + 200 };
}

test("the match window: TELEOP starts where the still transition ends; buzzer two minutes later", () => {
  const m = match(8, { lull: true });
  const w = detectMatchWindow(m.samples, m.duration);
  assert.ok(w, "found");
  assert.ok(Math.abs(w!.teleopStart - m.teleop) <= 0.4, `TELEOP at ${w!.teleopStart}`);
  assert.ok(Math.abs(w!.buzzer - m.buzzer) <= 0.4, `buzzer at ${w!.buzzer}`);
  assert.equal(w!.transitionSec, 8);
  assert.ok(w!.final);
  // the scoring window covers the whole of AUTO (it starts before AUTO + the longest transition)
  assert.ok(w!.start <= 20 && w!.start >= 20 - 8, `start ${w!.start}`);
  assert.equal(MATCH_SEC, 158);
  assert.ok(SETTLE_SEC > 0 && SETTLE_SEC <= 10);
});

test("the match window at the FIRST Championship (15 s transition)", () => {
  const m = match(15);
  const w = detectMatchWindow(m.samples, m.duration)!;
  assert.ok(Math.abs(w.buzzer - m.buzzer) <= 0.4, `buzzer at ${w.buzzer}`);
  assert.ok(w.start <= 20 + 1e-6, `start ${w.start}`);
});

test("live: the start of AUTO is never taken for TELEOP, and the window is final long before the buzzer", () => {
  const m = match(8);
  let finalAt: number | null = null;
  for (let now = 5; now <= m.duration; now += 1) {
    const w = detectMatchWindow(m.samples.filter((s) => s.t <= now), m.duration, now);
    if (!w?.final) continue;
    finalAt ??= now;
    assert.ok(Math.abs(w.buzzer - m.buzzer) <= 0.4, `at ${now}s the final buzzer was ${w.buzzer}`);
  }
  assert.ok(finalAt != null && finalAt < m.buzzer - 30, `final at ${finalAt}`);
});

test("a recording that stops before the buzzer, or starts during AUTO, still gives the window", () => {
  const m = match(8);
  const early = m.samples.filter((s) => s.t < m.buzzer - 8);
  const w = detectMatchWindow(early, m.buzzer - 8)!;
  assert.ok(Math.abs(w.buzzer - m.buzzer) <= 0.4, `buzzer at ${w.buzzer}`);
  const late = m.samples.filter((s) => s.t >= 30);
  const v = detectMatchWindow(late, m.duration)!;
  assert.ok(Math.abs(v.buzzer - m.buzzer) <= 0.4, `buzzer at ${v.buzzer}`);
});

test("no match in the video: no window", () => {
  assert.equal(detectMatchWindow(series([[300, 0.08]]), 300), null); // people milling about, no still transition
  assert.equal(detectMatchWindow(series([[300, 0.001]]), 300), null); // an empty field
  // a still field that comes alive only for a short time (people resetting it)
  assert.equal(detectMatchWindow(series([[100, 0.001], [130, 0.2], [300, 0.001]]), 300), null);
});

// ---- the measurement ---------------------------------------------------------------------

const W = 640;
const H = 360;
const FOV = 60;
const pose = lookAt([0, 150, 90], [0, -20, 0]);
const cam: CameraSolution = { pose, intrinsics: intrinsicsFromFov(W, H, FOV) };

function shifted(cv: CV, f: Frame, dx: number, dy: number, robotAt: Vec3 | null): Frame {
  const m = cv.matFromImageData(f);
  if (robotAt) {
    // an 18 in robot seen from this camera
    const c = projectPoint(robotAt, cam.pose, cam.intrinsics).uv;
    const e = projectPoint([robotAt[0] + 9, robotAt[1], robotAt[2]], cam.pose, cam.intrinsics).uv;
    const r = Math.max(4, Math.round(Math.abs(e[0] - c[0])));
    cv.rectangle(m, new cv.Point(Math.round(c[0] - r), Math.round(c[1] - r)), new cv.Point(Math.round(c[0] + r), Math.round(c[1] + r)), new cv.Scalar(30, 30, 30, 255), -1);
  }
  const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, dx, 0, 1, dy]);
  const out = new cv.Mat();
  cv.warpAffine(m, out, M, new cv.Size(f.width, f.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const r = { data: new Uint8ClampedArray(out.data), width: f.width, height: f.height };
  m.delete();
  M.delete();
  out.delete();
  return r;
}

test("FieldMotion: a robot driving on the FIELD is motion, a panning camera over a still field is not", async () => {
  const cv = await initNodeOpenCV();
  const model = getFieldModel();
  const base = renderField(cv, model, { width: W, height: H, fovDeg: FOV, pose, realism: { seed: 5, people: 6, noise: 3 } }).frame;
  const level = (frames: (t: number) => Frame) => {
    const fm = new FieldMotion(cv, model, cam, base);
    assert.ok(fm.available);
    for (let i = 0; i <= 50; i++) fm.push(frames(i * 0.2), i * 0.2);
    fm.dispose();
    return fm.samples.reduce((a, s) => a + s.motion, 0) / Math.max(1, fm.samples.length);
  };
  const still = level(() => base);
  const pan = level((t) => shifted(cv, base, 1.5 * t, 0.8 * t, null));
  const robot = level((t) => shifted(cv, base, 0, 0, [-30 + 6 * t, -10 + 2 * t, 9]));
  assert.ok(still < 0.001, `still field ${still}`);
  assert.ok(pan < 0.005, `panning camera ${pan}`);
  assert.ok(robot > 5 * Math.max(pan, 0.001), `robot ${robot} vs pan ${pan}`);
});
