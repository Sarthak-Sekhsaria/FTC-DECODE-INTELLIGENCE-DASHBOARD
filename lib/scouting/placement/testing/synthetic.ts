/* eslint-disable @typescript-eslint/no-explicit-any */
// Test-only helpers: a Node OpenCV.js instance and a synthetic renderer that draws
// the field model (floor, TILE seams, walls, GOALS, AprilTags) from a known camera
// pose, so every placement method can be checked against ground truth.

import { setOpenCV, whenReady, type CV } from "../cv.ts";
import { intrinsicsFromFov, projectPoint, projectSegment, type Intrinsics, type Pose, type Vec2, type Vec3 } from "../geometry.ts";
import type { FieldModel } from "../fieldModel.ts";
import type { FrameImage } from "../apriltag.ts";

let cvP: Promise<CV> | null = null;
export function initNodeOpenCV(): Promise<CV> {
  if (!cvP) {
    cvP = (async () => {
      const mod: any = await import("@techstark/opencv-js");
      const cv = await whenReady(mod.default ?? mod);
      setOpenCV(cv);
      return cv;
    })();
  }
  return cvP;
}

export interface RenderOptions {
  width: number;
  height: number;
  fovDeg: number;
  pose: Pose;
  drawTags?: boolean;
  drawGrid?: boolean;
  drawGoals?: boolean;
  swapGoalColours?: boolean;
  launchLines?: boolean;
  drawMarkings?: boolean; // floor tape (field_model markings), default on — real fields always have it
  drawRails?: boolean; // bright RAMP / perimeter rails, default on
  // Real-footage nuisances for robustness tests (all deterministic from `seed`).
  realism?: {
    seed: number;
    floorTint?: [number, number, number]; // TILE colour (default neutral grey)
    people?: number; // coloured blobs around the field (incl. red / blue / white shirts)
    robots?: number; // dark boxes standing on the field
    overlay?: boolean; // broadcast score banner (red + blue) along the bottom
    blur?: number; // Gaussian sigma (px)
    noise?: number; // uniform noise amplitude (0..255)
  };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillPoly(cv: CV, img: any, pts: Vec2[], color: number[]) {
  if (pts.length < 3) return;
  const m = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap((p) => [Math.round(p[0]), Math.round(p[1])]));
  const v = new cv.MatVector();
  v.push_back(m);
  cv.fillPoly(img, v, new cv.Scalar(...color));
  v.delete();
  m.delete();
}

function line3(cv: CV, img: any, a: Vec3, b: Vec3, pose: Pose, K: Intrinsics, color: number[], thick: number) {
  const s = projectSegment(a, b, pose, K);
  if (!s) return;
  const clampP = (p: Vec2) => new cv.Point(Math.max(-1e5, Math.min(1e5, Math.round(p[0]))), Math.max(-1e5, Math.min(1e5, Math.round(p[1]))));
  cv.line(img, clampP(s[0]), clampP(s[1]), new cv.Scalar(...color), thick, cv.LINE_AA);
}

function polyProj(pts: Vec3[], pose: Pose, K: Intrinsics): Vec2[] | null {
  const out: Vec2[] = [];
  for (const p of pts) {
    const r = projectPoint(p, pose, K);
    if (r.depth <= 0.5) return null;
    out.push(r.uv);
  }
  return out;
}

// Warp a real 36h11 marker (with its white quiet-zone border, CM §9.10: 8.125 in
// total around the 6.5 in black square) onto the projected tag corners.
function drawTag(cv: CV, img: any, id: number, corners: Vec3[], pose: Pose, K: Intrinsics) {
  const proj = polyProj(corners, pose, K);
  if (!proj) return;
  const cell = 24;
  const dict = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  const marker = new cv.Mat();
  dict.generateImageMarker(id, cell * 8, marker, 1); // black border + 6x6 bits = 8 cells
  const padded = new cv.Mat();
  cv.copyMakeBorder(marker, padded, cell, cell, cell, cell, cv.BORDER_CONSTANT, new cv.Scalar(255));
  const rgba = new cv.Mat();
  cv.cvtColor(padded, rgba, cv.COLOR_GRAY2RGBA);
  // Expand projected black-square corners outward to the white border (x 10/8).
  const c = proj.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  const grow = (p: Vec2): Vec2 => [c[0] + (p[0] - c[0]) * 1.25, c[1] + (p[1] - c[1]) * 1.25];
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, cell * 10, 0, cell * 10, cell * 10, 0, cell * 10]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, proj.map(grow).flat());
  const H = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();
  const mask = new cv.Mat();
  const ones = new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1, new cv.Scalar(255));
  cv.warpPerspective(rgba, warped, H, new cv.Size(img.cols, img.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  cv.warpPerspective(ones, mask, H, new cv.Size(img.cols, img.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  warped.copyTo(img, mask);
  for (const m of [dict, marker, padded, rgba, src, dst, H, warped, mask, ones]) m.delete();
}

export function renderField(cv: CV, model: FieldModel, o: RenderOptions): { frame: FrameImage; K: Intrinsics } {
  const K = intrinsicsFromFov(o.width, o.height, o.fovDeg);
  const img = new cv.Mat(o.height, o.width, cv.CV_8UC4, new cv.Scalar(18, 20, 28, 255));
  const pose = o.pose;
  const re = o.realism;
  const rand = rng(re?.seed ?? 1);
  const tile = re?.floorTint ? [...re.floorTint, 255] : [112, 112, 114, 255];
  const palette = [[200, 30, 35], [30, 70, 200], [235, 235, 235], [40, 40, 45], [60, 140, 60], [180, 150, 110], [230, 200, 60], [90, 90, 95]];
  const person = (cx: number, cy: number, rx: number) => {
    const c = palette[Math.floor(rand() * palette.length)];
    const ry = rx * (1.8 + rand() * 0.8);
    cv.ellipse(img, new cv.Point(Math.round(cx), Math.round(cy)), new cv.Size(Math.max(1, Math.round(rx)), Math.max(1, Math.round(ry))), 0, 0, 360, new cv.Scalar(c[0], c[1], c[2], 255), -1);
    const head = Math.max(1, Math.round(rx * 0.55));
    cv.circle(img, new cv.Point(Math.round(cx), Math.round(cy - ry - head * 0.8)), head, new cv.Scalar(150 + rand() * 60, 110 + rand() * 50, 90 + rand() * 40, 255), -1);
  };
  // Venue first (arena carpet, spectators), everything on the field covers it.
  if (re) {
    const carpet = [[45, 45, 50], [50, 58, 80], [28, 28, 32], [70, 70, 72]][Math.floor(rand() * 4)];
    for (let x = -150; x < 150; x += 30)
      for (let y = -150; y < 150; y += 30) {
        const p = polyProj([[x, y, 0], [x + 30, y, 0], [x + 30, y + 30, 0], [x, y + 30, 0]], pose, K);
        if (p) fillPoly(cv, img, p, [...carpet, 255]);
      }
  }
  if (re?.people) {
    for (let i = 0; i < re.people; i++) person(rand() * o.width, rand() * o.height, (0.012 + rand() * 0.02) * o.width);
    // crowds are textured
    const d = img.data as Uint8Array;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 50;
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, d[i + c] + n));
    }
  }
  const X = model.gridLinesX;
  const Y = model.gridLinesY;
  const x0 = X[0], x1 = X[X.length - 1], y0 = Y[0], y1 = Y[Y.length - 1];

  // Floor: draw per tile so partially-visible floors still render.
  for (let i = 0; i + 1 < X.length; i++)
    for (let j = 0; j + 1 < Y.length; j++) {
      const p = polyProj([[X[i], Y[j], 0], [X[i + 1], Y[j], 0], [X[i + 1], Y[j + 1], 0], [X[i], Y[j + 1], 0]], pose, K);
      if (p) fillPoly(cv, img, p, tile);
    }
  // Perimeter walls (light polycarbonate / rails) up to the model wall height.
  const h = model.wallTopZ;
  const wall: [Vec3, Vec3][] = [
    [[x0, y0, 0], [x1, y0, 0]],
    [[x1, y0, 0], [x1, y1, 0]],
    [[x1, y1, 0], [x0, y1, 0]],
    [[x0, y1, 0], [x0, y0, 0]],
  ];
  // (clear polycarbonate in realism mode: the floor shows through)
  const wallLayer = re ? img.clone() : img;
  for (const [a, b] of wall) {
    const p = polyProj([a, b, [b[0], b[1], h], [a[0], a[1], h]], pose, K);
    if (p) fillPoly(cv, wallLayer, p, [185, 190, 198, 255]);
  }
  if (re) {
    cv.addWeighted(wallLayer, 0.15, img, 0.85, 0, img);
    wallLayer.delete();
  }
  if (o.drawGrid !== false) {
    for (const x of model.seamsX) line3(cv, img, [x, y0, 0], [x, y1, 0], pose, K, [52, 52, 55, 255], 2);
    for (const y of model.seamsY) line3(cv, img, [x0, y, 0], [x1, y, 0], pose, K, [52, 52, 55, 255], 2);
  }
  if (o.drawMarkings !== false) {
    const thick = Math.max(2, Math.round(o.width / 500));
    for (const m of model.markings) {
      const pts = m.closed ? [...m.points, m.points[0]] : m.points;
      const colour = m.colour === "white" ? [245, 245, 245, 255] : m.colour === "red" ? [220, 30, 35, 255] : [30, 90, 230, 255];
      for (let i = 0; i + 1 < pts.length; i++) line3(cv, img, pts[i], pts[i + 1], pose, K, colour, thick);
    }
  }
  if (o.launchLines) {
    // White LAUNCH LINE diagonals (CM Fig 9-2) as distractors.
    line3(cv, img, [x0, y0, 0], [0, 0, 0], pose, K, [240, 240, 240, 255], 2);
    line3(cv, img, [x1, y0, 0], [0, 0, 0], pose, K, [240, 240, 240, 255], 2);
  }
  if (o.drawGoals !== false) {
    for (const g of model.goals) {
      const alliance = o.swapGoalColours ? (g.alliance === "red" ? "blue" : "red") : g.alliance;
      const col = alliance === "red" ? [210, 25, 30, 255] : [25, 70, 215, 255];
      // Coloured panels from the CAD (all one colour, so drawing order does not matter).
      for (const f of [...g.panels.body, g.panels.blocker]) {
        const p = polyProj(f, pose, K);
        if (p) fillPoly(cv, img, p, col);
      }
    }
  }
  // Bright aluminium RAMP rails and perimeter top rails.
  if (o.drawRails !== false)
    for (const l of model.structureLines)
      for (let i = 0; i + 1 < l.points.length; i++) line3(cv, img, l.points[i], l.points[i + 1], pose, K, [235, 235, 238, 255], Math.max(1, Math.round(o.width / 700)));
  if (o.drawTags !== false) for (const t of model.tags) drawTag(cv, img, t.id, t.corners, pose, K);
  if (re?.robots) {
    // 18 in boxes on the field (CM robot size limit), dark with a coloured stripe.
    for (let i = 0; i < re.robots; i++) {
      const x = (rand() - 0.5) * 110;
      const y = (rand() - 0.5) * 110;
      const s2 = 9;
      const b: Vec3[] = [[x - s2, y - s2, 0], [x + s2, y - s2, 0], [x + s2, y + s2, 0], [x - s2, y + s2, 0]];
      const t: Vec3[] = b.map((p) => [p[0], p[1], 14]);
      const faces = [t, ...b.map((p, k) => [p, b[(k + 1) % 4], t[(k + 1) % 4], t[k]])];
      for (const f of faces) {
        const p = polyProj(f, pose, K);
        if (p) fillPoly(cv, img, p, [35 + rand() * 30, 35 + rand() * 30, 40 + rand() * 30, 255]);
      }
    }
  }
  // a referee / team member standing between the camera and the field
  if (re && rand() < 0.5) person(rand() * o.width, o.height * (0.75 + rand() * 0.2), (0.04 + rand() * 0.03) * o.width);
  if (re?.overlay) {
    const h0 = Math.round(o.height * 0.84);
    cv.rectangle(img, new cv.Point(0, h0), new cv.Point(Math.round(o.width * 0.45), o.height), new cv.Scalar(190, 25, 30, 255), -1);
    cv.rectangle(img, new cv.Point(Math.round(o.width * 0.55), h0), new cv.Point(o.width, o.height), new cv.Scalar(25, 70, 200, 255), -1);
    cv.rectangle(img, new cv.Point(Math.round(o.width * 0.45), h0), new cv.Point(Math.round(o.width * 0.55), o.height), new cv.Scalar(245, 245, 245, 255), -1);
  }
  if (re?.blur) cv.GaussianBlur(img, img, new cv.Size(0, 0), re.blur, re.blur);
  if (re?.noise) {
    const d = img.data as Uint8Array;
    for (let i = 0; i < d.length; i++) if ((i & 3) !== 3) d[i] = Math.max(0, Math.min(255, d[i] + (rand() - 0.5) * 2 * re.noise));
  }

  const data = new Uint8ClampedArray(img.data);
  img.delete();
  return { frame: { data, width: o.width, height: o.height }, K };
}
