// The RAMP strip: one RAMP's lane cut out of a frame and straightened, the input of the v2
// counter's ARTIFACT detector (ml/strip/detector.py). Along the lane from slot -0.5 (the GATE end)
// to slot 8.5 (the top, where ARTIFACTS come on from the SQUARE) at STRIP_PX px per slot, across it
// +-STRIP_ACROSS ball radii: 144 x 40 px, an ARTIFACT 16 px across whatever the camera. The
// training data was cut by exactly this code's arithmetic (scratch tool mkStrips2.ts).

import type { Frame } from "./calibration.ts";
import type { Vec2 } from "./placement/geometry.ts";

export const STRIP_SLOTS = 9;
export const STRIP_PX = 16;
export const STRIP_ACROSS = 2.5;
export const STRIP_W = STRIP_PX * STRIP_SLOTS; // 144
export const STRIP_H = Math.round(2 * STRIP_ACROSS * (STRIP_PX / 2)); // 40

// Bilinear RGB sample of the frame at (x, y) into out[o..o+2]; black outside the frame.
function sampleRGB(f: Frame, x: number, y: number, out: Uint8Array, o: number) {
  if (x < 0 || y < 0 || x > f.width - 1.001 || y > f.height - 1.001) {
    out[o] = out[o + 1] = out[o + 2] = 0;
    return;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const i00 = (y0 * f.width + x0) * 4 + c, i10 = i00 + 4, i01 = i00 + f.width * 4, i11 = i01 + 4;
    out[o + c] = Math.round((1 - fx) * (1 - fy) * f.data[i00] + fx * (1 - fy) * f.data[i10] + (1 - fx) * fy * f.data[i01] + fx * fy * f.data[i11]);
  }
}

// The strip of one RAMP in this frame: the 9 slot centres (frame px, GATE end first) and the
// ball radius at each (px). Row-major RGB, STRIP_H rows of STRIP_W pixels.
export function cutStrip(f: Frame, centres: Vec2[], radii: number[], out = new Uint8Array(STRIP_W * STRIP_H * 3)): Uint8Array {
  for (let u = 0; u < STRIP_W; u++) {
    const s = (u + 0.5) / STRIP_PX - 0.5;
    const k = Math.max(0, Math.min(STRIP_SLOTS - 2, Math.floor(s)));
    const a = s - k;
    const c0 = centres[k], c1 = centres[k + 1];
    const cx = c0[0] + a * (c1[0] - c0[0]), cy = c0[1] + a * (c1[1] - c0[1]);
    const r = radii[k] + a * (radii[k + 1] - radii[k]);
    const dx = c1[0] - c0[0], dy = c1[1] - c0[1], dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl, ny = dx / dl;
    for (let v = 0; v < STRIP_H; v++) {
      const q = ((v + 0.5) / STRIP_H - 0.5) * 2 * STRIP_ACROSS;
      sampleRGB(f, cx + nx * q * r, cy + ny * q * r, out, (v * STRIP_W + u) * 3);
    }
  }
  return out;
}

// The detector's input tensor for n strips: n x 3 x STRIP_H x STRIP_W, RGB / 255 (planar).
export function stripsToTensor(strips: Uint8Array[]): Float32Array {
  const plane = STRIP_W * STRIP_H;
  const out = new Float32Array(strips.length * 3 * plane);
  strips.forEach((s, n) => {
    const base = n * 3 * plane;
    for (let i = 0; i < plane; i++) {
      out[base + i] = s[i * 3] / 255;
      out[base + plane + i] = s[i * 3 + 1] / 255;
      out[base + 2 * plane + i] = s[i * 3 + 2] / 255;
    }
  });
  return out;
}
