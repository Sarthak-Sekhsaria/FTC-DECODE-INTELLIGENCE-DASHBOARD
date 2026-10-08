// The RAMP strip geometry: the strip samples the frame along the lane (GATE end on the left) and
// across it (+-2.5 ball radii), so an ARTIFACT resting in slot k is centred at strip column
// 16k + 8, row 20, at 16 px across, whatever its size and direction in the frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cutStrip, STRIP_H, STRIP_W } from "./rampStrip.ts";
import type { Vec2 } from "./placement/geometry.ts";

function frameWithDisc(w: number, h: number, cx: number, cy: number, r: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = Math.hypot(x - cx, y - cy) <= r;
      data[i] = inside ? 200 : 60;
      data[i + 1] = inside ? 40 : 60;
      data[i + 2] = inside ? 200 : 60;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

// where the disc is in the strip: the centroid of its (purple) pixels
function centroid(s: Uint8Array) {
  let n = 0, su = 0, sv = 0;
  for (let v = 0; v < STRIP_H; v++)
    for (let u = 0; u < STRIP_W; u++) {
      const o = (v * STRIP_W + u) * 3;
      if (s[o] > 130 && s[o + 1] < 50) {
        n++;
        su += u;
        sv += v;
      }
    }
  return { n, u: su / n, v: sv / n };
}

test("rampStrip: an ARTIFACT in slot 3 lands at column 56, row 20, 16 px across — any lane direction and size", () => {
  for (const [angle, r] of [[0, 6], [Math.PI / 5, 10], [-2.2, 4]] as const) {
    const W = 640, H = 480;
    const dir: Vec2 = [Math.cos(angle), Math.sin(angle)];
    const origin: Vec2 = [320 - dir[0] * 4 * 2 * r, 240 - dir[1] * 4 * 2 * r];
    // slots one ball (2r) apart along the lane; slot 3 holds the ARTIFACT
    const centres: Vec2[] = Array.from({ length: 9 }, (_, k) => [origin[0] + dir[0] * 2 * r * k, origin[1] + dir[1] * 2 * r * k]);
    const f = frameWithDisc(W, H, centres[3][0], centres[3][1], r);
    const s = cutStrip(f, centres, new Array(9).fill(r));
    const c = centroid(s);
    assert.ok(Math.abs(c.u - (16 * 3 + 7.5)) < 1, `angle ${angle}: column ${c.u}`);
    assert.ok(Math.abs(c.v - 19.5) < 1, `angle ${angle}: row ${c.v}`);
    // its area: a disc of radius 8 px in the strip
    assert.ok(Math.abs(c.n - Math.PI * 64) < 30, `angle ${angle}: area ${c.n}`);
  }
});
