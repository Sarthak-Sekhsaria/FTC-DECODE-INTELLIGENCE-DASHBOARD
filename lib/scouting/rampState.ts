// RAMP lane geometry for Auto Scouting (DOM-free, unit-testable).
//
// The lower RAMP holds exactly 9 CLASSIFIED ARTIFACTS (CM §9.8.2), which queue from the
// GATE up toward where new ARTIFACTS land. Using the camera pose from ROI placement, each of
// the 9 slots is sampled at the parts of a 5 in ball (CM §9.9) that the camera can really
// see — the lower-RAMP blocker and the GOAL panels are opaque and hide part of the RAMP from
// low, field-side cameras. rampQueue.ts turns those samples into a count.

import type { FieldModel, RampModel } from "./placement/fieldModel.ts";
import { projectPoint, type Vec2, type Vec3 } from "./placement/geometry.ts";
import type { CameraSolution, Frame } from "./calibration.ts";

export const SLOTS = 9; // CM §9.8.2
const BALL_R = 2.5; // CM §9.9: 5 in
// A 5 in ARTIFACT (CM §9.9) rests on the top inner edges of the two lower-RAMP rails, which are
// 80.5 mm apart in the field CAD ("Ramp 45in Two-Hole Extrusion - am-5733": red rails x
// 1621.2..1655.0 and 1735.5..1769.3 mm, blue mirrored). Its centre is therefore
// sqrt(63.5² - 40.25²) = 49.1 mm = 1.93 in above the rail tops (gateEnd / lowerRampStart).
export const CENTRE_ABOVE_RAIL = 1.93;

// ---- colour space ------------------------------------------------------------------

export type Lab = [number, number, number];

function srgbToLinear(c: number) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
function fLab(t: number) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Colour distance that cares less about brightness (shadows, lighting across the field).
export function labDist(a: Lab, b: Lab, lightWeight = 0.5): number {
  const dl = (a[0] - b[0]) * lightWeight;
  return Math.hypot(dl, a[1] - b[1], a[2] - b[2]);
}

// For display (debug swatches): Lab back to 8-bit sRGB.
export function labToRgb(lab: Lab): [number, number, number] {
  const fy = (lab[0] + 16) / 116, fx = fy + lab[1] / 500, fz = fy - lab[2] / 200;
  const inv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const lin = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  }) as [number, number, number];
}

// Lab at pixel (x, y) of an RGBA frame (nearest pixel), or NaNs when outside the frame.
export function labAt(f: Frame, x: number, y: number, out: Float32Array, at: number) {
  const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
  if (!(xi >= 0 && yi >= 0 && xi < f.width && yi < f.height)) {
    out[at] = out[at + 1] = out[at + 2] = NaN;
    return;
  }
  const i = (yi * f.width + xi) * 4;
  const l = rgbToLab(f.data[i], f.data[i + 1], f.data[i + 2]);
  out[at] = l[0];
  out[at + 1] = l[1];
  out[at + 2] = l[2];
}

// ---- geometry ----------------------------------------------------------------------

interface Occluder {
  n: Vec3; // plane normal
  d: number; // n·p = d
  pts: Vec3[]; // polygon (planar)
  u: Vec3; // in-plane axes for the point-in-polygon test
  v: Vec3;
  poly2: Vec2[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function makeOccluder(pts: Vec3[]): Occluder {
  const u = norm(sub(pts[1], pts[0]));
  const n = norm(cross(u, sub(pts[2], pts[0])));
  const v = cross(n, u);
  return { n, d: dot(n, pts[0]), pts, u, v, poly2: pts.map((p) => [dot(sub(p, pts[0]), u), dot(sub(p, pts[0]), v)] as Vec2) };
}

function inPoly2(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Is the segment camera -> point blocked by the occluder (strictly between them)?
function blocks(o: Occluder, cam: Vec3, p: Vec3): boolean {
  const dir = sub(p, cam);
  const den = dot(o.n, dir);
  if (Math.abs(den) < 1e-9) return false;
  const t = (o.d - dot(o.n, cam)) / den;
  if (t <= 0.02 || t >= 0.98) return false;
  const q: Vec3 = [cam[0] + dir[0] * t, cam[1] + dir[1] * t, cam[2] + dir[2] * t];
  const rel = sub(q, o.pts[0]);
  return inPoly2([dot(rel, o.u), dot(rel, o.v)], o.poly2);
}

function cameraCentreOf(cam: CameraSolution): Vec3 {
  const [rx, ry, rz] = cam.pose.rvec;
  const th = Math.hypot(rx, ry, rz);
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (th > 1e-12) {
    const k = [rx / th, ry / th, rz / th];
    const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    R = [
      c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
      k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
      k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C,
    ];
  }
  const t = cam.pose.tvec;
  // C = -R^T t
  return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

export interface SlotGeometry {
  centre: Vec3;
  points: Vec2[]; // visible sample points (native px)
  radiusPx: number; // projected ball radius
  visibleShare: number; // share of the ball's disc not hidden by field structure
}

export interface RampLane {
  alliance: "red" | "blue";
  slots: SlotGeometry[]; // 0 = against the GATE ... 8 = where ARTIFACTS land
}

// Slot centres: balls queue against the GATE, 5 in apart along the rails.
export function slotCentres(ramp: RampModel, centreAboveRail = CENTRE_ABOVE_RAIL): Vec3[] {
  const a = ramp.gateEnd;
  const b = ramp.lowerRampStart;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const d: Vec3 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L, (b[2] - a[2]) / L];
  const pitch = L / SLOTS; // ~5.06 in: the RAMP is sized for exactly 9 ARTIFACTS
  return Array.from({ length: SLOTS }, (_, k) => {
    const s = pitch * (k + 0.5);
    return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s + centreAboveRail] as Vec3;
  });
}

// Sample points on each slot's ball, facing the camera, keeping only those not hidden by the
// blocker / GOAL panels (of either alliance).
export function buildLane(model: FieldModel, ramp: RampModel, cam: CameraSolution, frame: { width: number; height: number }, centreAboveRail = CENTRE_ABOVE_RAIL): RampLane {
  const C = cameraCentreOf(cam);
  const occluders = model.goals.flatMap((g) => [...g.panels.body, g.panels.blocker].map(makeOccluder));
  const slots = slotCentres(ramp, centreAboveRail).map((centre) => {
    const view = norm(sub(centre, C));
    const e1 = norm(cross(view, [0, 0, 1]));
    const e2 = cross(e1, view);
    const pts: Vec2[] = [];
    let total = 0;
    const rings: [number, number][] = [[0, 1]];
    for (const [rf, n] of [[0.4, 6], [0.75, 10]] as const) for (let i = 0; i < n; i++) rings.push([rf, (2 * Math.PI * i) / n]);
    for (const [rf, ang] of rings) {
      const off = rf * BALL_R;
      const p: Vec3 = [
        centre[0] + (e1[0] * Math.cos(ang) + e2[0] * Math.sin(ang)) * off,
        centre[1] + (e1[1] * Math.cos(ang) + e2[1] * Math.sin(ang)) * off,
        centre[2] + (e1[2] * Math.cos(ang) + e2[2] * Math.sin(ang)) * off,
      ];
      total++;
      if (occluders.some((o) => blocks(o, C, p))) continue;
      const q = projectPoint(p, cam.pose, cam.intrinsics);
      if (q.depth <= 1 || q.uv[0] < 1 || q.uv[1] < 1 || q.uv[0] >= frame.width - 1 || q.uv[1] >= frame.height - 1) continue;
      pts.push(q.uv);
    }
    const c = projectPoint(centre, cam.pose, cam.intrinsics);
    return { centre, points: pts, radiusPx: c.depth > 1 ? (cam.intrinsics.fx * BALL_R) / c.depth : 0, visibleShare: pts.length / total };
  });
  return { alliance: ramp.alliance, slots };
}
