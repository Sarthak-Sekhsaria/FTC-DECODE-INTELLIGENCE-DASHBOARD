// Pure geometry helpers for automatic ROI placement (no OpenCV, no DOM), so they
// can be unit-tested and used for cheap per-render drawing. All image points are
// in native video pixels unless a function says "normalized".

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Pose {
  rvec: Vec3; // Rodrigues rotation vector (world -> camera)
  tvec: Vec3; // translation (world -> camera), inches
}

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  fovDeg: number; // horizontal field of view used to derive fx
  // Radial lens distortion: OpenCV's k1 on normalized image coordinates, x_d = x (1 + k1 r^2).
  // A wide lens bends straight lines outward from the centre (barrel, k1 < 0). Absent or 0: a
  // pinhole camera.
  k1?: number;
}

// ---- camera model -----------------------------------------------------------

// Principal point at the image centre, no lens distortion, square pixels; focal
// length from an assumed horizontal FOV (a camera assumption, not a field value).
// (A lens distortion fitted by the pose solver is set on the result as `k1`.)
export function intrinsicsFromFov(width: number, height: number, fovDeg: number): Intrinsics {
  const f = width / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height, fovDeg };
}

// Rodrigues vector -> 3x3 rotation matrix (row-major).
export function rodrigues(r: Vec3): number[] {
  const theta = Math.hypot(r[0], r[1], r[2]);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [kx, ky, kz] = [r[0] / theta, r[1] / theta, r[2] / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

// 3x3 rotation matrix (row-major) -> Rodrigues vector.
export function rotationToRodrigues(R: number[]): Vec3 {
  const cos = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const theta = Math.acos(cos);
  if (theta < 1e-9) return [0, 0, 0];
  if (Math.PI - theta < 1e-3) {
    // Near 180°: R ≈ 2kkᵀ - I. Take the largest diagonal term as the reference
    // axis component, then the others from the symmetric off-diagonals.
    const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2;
    let x: number, y: number, z: number;
    if (xx >= yy && xx >= zz) {
      x = Math.sqrt(xx);
      y = (R[1] + R[3]) / (4 * x);
      z = (R[2] + R[6]) / (4 * x);
    } else if (yy >= zz) {
      y = Math.sqrt(yy);
      x = (R[1] + R[3]) / (4 * y);
      z = (R[5] + R[7]) / (4 * y);
    } else {
      z = Math.sqrt(zz);
      x = (R[2] + R[6]) / (4 * z);
      y = (R[5] + R[7]) / (4 * z);
    }
    // Just below 180° the antisymmetric part still carries the axis sign.
    const s = (R[7] - R[5]) * x + (R[2] - R[6]) * y + (R[3] - R[1]) * z < 0 ? -1 : 1;
    const l = Math.hypot(x, y, z) * s;
    return [(x / l) * theta, (y / l) * theta, (z / l) * theta];
  }
  const k = theta / (2 * Math.sin(theta));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

// Pose of a camera at `eye` looking at `target` (world z up; image y down).
export function lookAt(eye: Vec3, target: Vec3, rollDeg = 0): Pose {
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const f = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  let r = norm(cross3(f, [0, 0, 1]));
  let d = cross3(f, r);
  if (rollDeg) {
    const a = (rollDeg * Math.PI) / 180;
    const r2: Vec3 = [r[0] * Math.cos(a) + d[0] * Math.sin(a), r[1] * Math.cos(a) + d[1] * Math.sin(a), r[2] * Math.cos(a) + d[2] * Math.sin(a)];
    d = cross3(f, r2);
    r = r2;
  }
  const R = [...r, ...d, ...f];
  const t: Vec3 = [
    -(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]),
    -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]),
    -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2]),
  ];
  return { rvec: rotationToRodrigues(R), tvec: t };
}

export function toCamera(p: Vec3, pose: Pose): Vec3 {
  const R = rodrigues(pose.rvec);
  const t = pose.tvec;
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ];
}

// Camera centre in world coordinates: C = -R^T t.
export function cameraCentre(pose: Pose): Vec3 {
  const R = rodrigues(pose.rvec);
  const t = pose.tvec;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

// Camera coordinates -> pixels, with the radial distortion. A barrel polynomial stops growing
// at r^2 = 1 / (3 |k1|), well outside the picture for any real lens; points beyond it (a line
// running far out of view) are held at that radius so they cannot fold back into the picture.
export function projectCam(pc: Vec3, K: Intrinsics): Vec2 {
  let x = pc[0] / pc[2], y = pc[1] / pc[2];
  const k1 = K.k1 ?? 0;
  if (k1) {
    let r2 = x * x + y * y;
    const lim = k1 < 0 ? 1 / (3 * -k1) : Infinity;
    if (r2 > lim) {
      const s = Math.sqrt(lim / r2);
      x *= s;
      y *= s;
      r2 = lim;
    }
    const d = 1 + k1 * r2;
    x *= d;
    y *= d;
  }
  return [K.fx * x + K.cx, K.fy * y + K.cy];
}

// Projection identical to cv.projectPoints with distortion coefficients [k1, 0, 0, 0] (zero
// when the intrinsics have none), inside the picture. Also returns camera-space depth so
// callers can reject points behind the camera.
export function projectPoint(p: Vec3, pose: Pose, K: Intrinsics): { uv: Vec2; depth: number } {
  const pc = toCamera(p, pose);
  return { uv: projectCam(pc, K), depth: pc[2] };
}

// Project a 3D segment, clipping it against a near plane so segments that pass
// behind the camera still draw correctly. Returns null if fully behind.
export function projectSegment(a: Vec3, b: Vec3, pose: Pose, K: Intrinsics, near = 1): [Vec2, Vec2] | null {
  let pa = toCamera(a, pose);
  let pb = toCamera(b, pose);
  if (pa[2] < near && pb[2] < near) return null;
  if (pa[2] < near || pb[2] < near) {
    const t = (near - pa[2]) / (pb[2] - pa[2]);
    const pn: Vec3 = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, near];
    if (pa[2] < near) pa = pn;
    else pb = pn;
  }
  return [projectCam(pa, K), projectCam(pb, K)];
}

// ---- statistics -------------------------------------------------------------

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

// ---- polygons ---------------------------------------------------------------

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Strictly convex, non-self-intersecting check: every consecutive edge turns the
// same way and the total winding is one full turn.
export function isConvex(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  let angleSum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = h2 - h1;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    angleSum += d;
  }
  return Math.abs(Math.abs(angleSum) - 2 * Math.PI) < 1e-6;
}

// Andrew's monotone chain; returns the hull counter-clockwise (in y-up terms).
export function convexHull(points: Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Sutherland–Hodgman clip of a polygon to the axis-aligned rect [0,w]x[0,h].
export function clipToRect(poly: Vec2[], w: number, h: number): Vec2[] {
  type Edge = { inside: (p: Vec2) => boolean; cut: (a: Vec2, b: Vec2) => Vec2 };
  const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const edges: Edge[] = [
    { inside: (p) => p[0] >= 0, cut: (a, b) => lerp(a, b, (0 - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] <= w, cut: (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] >= 0, cut: (a, b) => lerp(a, b, (0 - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] <= h, cut: (a, b) => lerp(a, b, (h - a[1]) / (b[1] - a[1])) },
  ];
  let out = poly;
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (e.inside(cur)) {
        if (!e.inside(prev)) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (e.inside(prev)) {
        out.push(e.cut(prev, cur));
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

// Intersection of a polygon with a CONVEX clip polygon (Sutherland–Hodgman).
export function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  if (clip.length < 3) return [];
  // Orient the clip polygon counter-clockwise (positive signed area) so "inside" is left.
  let signed = 0;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    signed += a[0] * b[1] - b[0] * a[1];
  }
  const c = signed < 0 ? [...clip].reverse() : clip;
  let out = subject;
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const sc = side(cur);
      const sp = side(prev);
      const cut = (): Vec2 => {
        const t = sp / (sp - sc);
        return [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      };
      if (sc >= 0) {
        if (sp < 0) out.push(cut());
        out.push(cur);
      } else if (sp >= 0) out.push(cut());
    }
  }
  return out;
}

// Intersection-over-union of two convex polygons.
export function convexIoU(a: Vec2[], b: Vec2[]): number {
  const inter = polygonArea(clipConvex(a, b));
  const u = polygonArea(a) + polygonArea(b) - inter;
  return u > 0 ? inter / u : 0;
}

export function bbox(points: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- lines (homogeneous) ----------------------------------------------------

export type HLine = Vec3; // a*x + b*y + c = 0

export function lineThrough(p: Vec2, q: Vec2): HLine {
  return [p[1] - q[1], q[0] - p[0], p[0] * q[1] - q[0] * p[1]];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Intersection of two homogeneous lines; null when (nearly) parallel.
export function intersect(l1: HLine, l2: HLine): Vec2 | null {
  const p = cross3(l1, l2);
  if (Math.abs(p[2]) < 1e-9 * (Math.abs(p[0]) + Math.abs(p[1]) + 1)) return null;
  return [p[0] / p[2], p[1] / p[2]];
}

// ---- homography (planar matching only — never used for the final ROI) -------

// Solve a small dense linear system A x = b (Gaussian elimination, partial pivot).
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Exact 4-point homography mapping src[i] -> dst[i] (h33 = 1).
export function homography4(src: Vec2[], dst: Vec2[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [...h, 1] : null;
}

export function applyH(H: number[], p: Vec2): Vec2 | null {
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(w) < 1e-12) return null;
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
}

// True when a set of 2D points is NOT (nearly) collinear: the smaller principal
// spread must be a meaningful fraction of the larger one.
export function nonCollinear(points: Vec2[], minRatio = 0.05): boolean {
  if (points.length < 3) return false;
  const mx = mean(points.map((p) => p[0]));
  const my = mean(points.map((p) => p[1]));
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  return l1 > 0 && Math.sqrt(Math.max(0, l2) / l1) >= minRatio;
}
