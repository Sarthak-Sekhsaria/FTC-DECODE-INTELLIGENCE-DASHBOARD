// Self-check of the automatic calibration: an ARTIFACT drawn at a known place and size must be
// measured at that size and offset, its holes notwithstanding; no ARTIFACT, no measurement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVerdict, measureArtifact, summarizeChecks, type ArtifactColours } from "./artifactCheck.ts";
import { rgbToLab } from "./rampState.ts";

const W = 160, H = 120;
const PURPLE_RGB = [125, 60, 175], GREEN_RGB = [40, 175, 80], FLOOR_RGB = [150, 150, 150];
const colours = (): ArtifactColours => {
  const p = rgbToLab(PURPLE_RGB[0], PURPLE_RGB[1], PURPLE_RGB[2]), g = rgbToLab(GREEN_RGB[0], GREEN_RGB[1], GREEN_RGB[2]);
  return { purple: p, green: g, purpleSigma: 12, greenSigma: 12, purpleChroma: Math.hypot(p[1], p[2]), greenChroma: Math.hypot(g[1], g[2]) };
};

// a frame with a ball of radius r at (cx, cy); `holes`: dark spots inside it, as on a whiffle ball
function frameWithBall(cx: number, cy: number, r: number, rgb: number[], holes = false) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const hole = holes && d < r && Math.hypot(((x + 0.5 - cx) % (r / 2)) - r / 4, ((y + 0.5 - cy) % (r / 2)) - r / 4) < r / 9;
      const c = d < r ? (hole ? [30, 20, 35] : rgb) : FLOOR_RGB;
      data.set([c[0], c[1], c[2], 255], i);
    }
  return { data, width: W, height: H };
}

test("self-check: a queued ARTIFACT is measured at its size and its distance from the lane", () => {
  const r = 12;
  // the lane runs straight down through x = 80; the ball sits 0.4 radii to one side of it
  const f = frameWithBall(80 + 0.4 * r, 60, r, PURPLE_RGB);
  const m = measureArtifact(f, [80, 60], [80, 60 + 2 * r], r, colours())!;
  assert.ok(m, "measured");
  assert.ok(Math.abs(m.size - 1) < 0.08, `size ${m.size}`);
  assert.ok(Math.abs(Math.abs(m.offset) - 0.4) < 0.1, `offset ${m.offset}`);
  assert.ok(m.colour < 0.5, `colour ${m.colour}`);
  // a whiffle ball's dark holes do not break it up
  const h = measureArtifact(frameWithBall(80, 60, r, GREEN_RGB, true), [80, 60], [80, 60 + 2 * r], r, colours())!;
  assert.ok(h && Math.abs(h.size - 1) < 0.1, `size with holes ${h?.size}`);
  // the automatic size three times too big: the check says so (the width is a coarse measure;
  // RAMPS that count right measured 0.44-1.6x on the benchmark, so smaller errors go unflagged)
  const big = measureArtifact(f, [80, 60], [80, 60 + 2 * r], 3 * r, colours())!;
  const v = checkVerdict(summarizeChecks([big, big, big])!);
  assert.equal(v.ok, false);
  // nothing there: no measurement
  assert.equal(measureArtifact(frameWithBall(-50, -50, r, PURPLE_RGB), [80, 60], [80, 60 + 2 * r], r, colours()), null);
});
