// Loads and validates the DECODE field model (field_model.json). Every number in
// that file cites the manual / official CAD; this module only checks it is
// structurally sound and exposes convenient accessors.

import rawModel from "./field_model.json" with { type: "json" };
import type { Vec2, Vec3 } from "./geometry.ts";

export type Alliance = "red" | "blue";

export interface PerimeterCorner {
  label: string;
  nearest: string;
  point: Vec3;
}

export interface TagModel {
  id: number;
  goal: Alliance;
  centre: Vec3;
  corners: [Vec3, Vec3, Vec3, Vec3]; // TL, TR, BR, BL (detector order)
}

export interface RampModel {
  alliance: Alliance;
  // ROI region: [goal (SQUARE) end field side, goal end wall side, gate end wall side, gate end field side]
  surfaceCorners: [Vec3, Vec3, Vec3, Vec3];
  clearanceHeight: number;
  lowerRampStart: Vec3; // centre of the lower RAMP where ARTIFACTS land after leaving the GOAL
  gateEnd: Vec3; // centre of the lower RAMP at the GATE
}

export interface GoalModel {
  alliance: Alliance;
  footprint: Vec3[];
  topLip: Vec3[];
  frontFace: Vec3[];
  backboardTopZ: number;
  // Alliance-coloured panels (field-facing face outlines): the GOAL body — front, rear,
  // backboard and archway panels, convex as a group — and the lower-RAMP blocker.
  panels: { body: Vec3[][]; blocker: Vec3[] };
}

export type MarkingColour = "white" | "red" | "blue";

export interface Marking {
  name: string;
  colour: MarkingColour;
  closed: boolean;
  points: Vec3[]; // tape centre-line polyline on the floor (z = 0)
}

export interface FieldModel {
  perimeterCorners: PerimeterCorner[]; // tap order: red-goal corner, then clockwise from above
  wallTopZ: number;
  tilePitch: number;
  seamsX: number[];
  seamsY: number[];
  gridLinesX: number[]; // seams + floor/wall boundaries
  gridLinesY: number[];
  tagFamily: string;
  tagBlackSize: number;
  excludedTagIds: number[];
  tags: TagModel[];
  ramps: RampModel[];
  goals: GoalModel[];
  markings: Marking[];
  structureLines: { name: string; points: Vec3[] }[]; // raised bright metal edges (rails)
}

export class FieldModelError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// All points on the plane of the first three non-collinear ones.
function isPlanar(pts: Vec3[], tol: number): boolean {
  const a = pts[0];
  for (let i = 1; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const u: Vec3 = [pts[i][0] - a[0], pts[i][1] - a[1], pts[i][2] - a[2]];
      const v: Vec3 = [pts[j][0] - a[0], pts[j][1] - a[1], pts[j][2] - a[2]];
      const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const nl = Math.hypot(...n);
      if (nl < 1) continue;
      return pts.every((p) => Math.abs((n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]) + n[2] * (p[2] - a[2])) / nl) < tol);
    }
  return false;
}

function need<T>(cond: T, msg: string): asserts cond {
  if (!cond) throw new FieldModelError(`field_model.json: ${msg}`);
}

// Validate the raw JSON and return a typed model. Throws FieldModelError with a
// specific message on the first problem found.
export function parseFieldModel(raw: unknown, tolIn = 0.02): FieldModel {
  const r = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  need(r && typeof r === "object", "not an object");
  need(r.coordinateSystem?.units === "inches", "coordinateSystem.units must be 'inches'");

  // Perimeter
  const pc = r.field?.perimeterCorners;
  need(Array.isArray(pc) && pc.length === 4, "field.perimeterCorners must have 4 corners");
  for (const [i, c] of pc.entries()) {
    need(isVec3(c.point), `perimeterCorners[${i}].point must be [x,y,z]`);
    need(Math.abs(c.point[2]) < 1e-9, `perimeterCorners[${i}] must be at z = 0`);
    need(typeof c.label === "string" && c.label.length > 0, `perimeterCorners[${i}].label missing`);
  }
  need(isNum(r.field.wallTopZ), "field.wallTopZ missing");

  // Tiles
  const t = r.tiles;
  need(t && isNum(t.pitch) && t.pitch > 0, "tiles.pitch missing");
  for (const k of ["seamsX", "seamsY", "gridLinesX", "gridLinesY"]) {
    need(Array.isArray(t[k]) && t[k].length >= 2 && t[k].every(isNum), `tiles.${k} must be a number array`);
    for (let i = 1; i < t[k].length; i++) need(t[k][i] > t[k][i - 1], `tiles.${k} must be strictly increasing`);
  }
  for (let i = 1; i < t.seamsX.length; i++) {
    need(Math.abs(t.seamsX[i] - t.seamsX[i - 1] - t.pitch) < tolIn, "tiles.seamsX spacing must equal tiles.pitch");
    need(Math.abs(t.seamsY[i] - t.seamsY[i - 1] - t.pitch) < tolIn, "tiles.seamsY spacing must equal tiles.pitch");
  }

  // AprilTags
  const at = r.apriltags;
  need(at && at.family === "36h11", "apriltags.family must be '36h11' (CM §9.10)");
  need(isNum(at.blackSquareSize) && at.blackSquareSize > 0, "apriltags.blackSquareSize missing");
  need(Array.isArray(at.tags) && at.tags.length > 0, "apriltags.tags missing");
  const s = at.blackSquareSize as number;
  const ids = new Set<number>();
  for (const tag of at.tags) {
    need(Number.isInteger(tag.id), "tag.id must be an integer");
    need(!ids.has(tag.id), `duplicate tag id ${tag.id}`);
    ids.add(tag.id);
    need(tag.goal === "red" || tag.goal === "blue", `tag ${tag.id}.goal must be red|blue`);
    need(Array.isArray(tag.corners) && tag.corners.length === 4 && tag.corners.every(isVec3), `tag ${tag.id} needs 4 [x,y,z] corners`);
    const c = tag.corners as Vec3[];
    for (let i = 0; i < 4; i++) {
      const side = dist3(c[i], c[(i + 1) % 4]);
      need(Math.abs(side - s) < tolIn, `tag ${tag.id} side ${i} is ${side.toFixed(3)} in, expected ${s} in (CM Fig 9-19)`);
    }
    const diag = s * Math.SQRT2;
    need(Math.abs(dist3(c[0], c[2]) - diag) < tolIn && Math.abs(dist3(c[1], c[3]) - diag) < tolIn, `tag ${tag.id} corners are not a square`);
    // Coplanarity: the 4th corner must lie on the plane of the first 3.
    const u: Vec3 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
    const v: Vec3 = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
    const w: Vec3 = [c[2][0] - c[0][0], c[2][1] - c[0][1], c[2][2] - c[0][2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(...n);
    need(Math.abs((n[0] * w[0] + n[1] * w[1] + n[2] * w[2]) / nl) < tolIn, `tag ${tag.id} corners are not coplanar`);
  }
  const excluded: number[] = Array.isArray(at.excluded?.ids) ? at.excluded.ids : [];

  // Ramps
  need(Array.isArray(r.ramps) && r.ramps.length > 0, "ramps missing");
  for (const rp of r.ramps) {
    need(rp.alliance === "red" || rp.alliance === "blue", "ramp.alliance must be red|blue");
    need(Array.isArray(rp.surfaceCorners) && rp.surfaceCorners.length === 4 && rp.surfaceCorners.every(isVec3), `${rp.alliance} ramp needs 4 [x,y,z] surfaceCorners`);
    const c = rp.surfaceCorners as Vec3[];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        need(dist3(c[i], c[j]) > 0.5, `${rp.alliance} ramp corners ${i} and ${j} are not distinct`);
    need(isNum(rp.clearanceHeight) && rp.clearanceHeight > 0, `${rp.alliance} ramp clearanceHeight missing`);
    need(isVec3(rp.lowerRampStart) && isVec3(rp.gateEnd), `${rp.alliance} ramp lowerRampStart / gateEnd missing`);
    need(dist3(rp.lowerRampStart, rp.gateEnd) > 1, `${rp.alliance} ramp lowerRampStart and gateEnd coincide`);
  }

  // Goals
  need(Array.isArray(r.goals) && r.goals.length > 0, "goals missing");
  for (const g of r.goals) {
    need(g.alliance === "red" || g.alliance === "blue", "goal.alliance must be red|blue");
    for (const k of ["footprint", "topLip", "frontFace"]) need(Array.isArray(g[k]) && g[k].length >= 3 && g[k].every(isVec3), `${g.alliance} goal.${k} invalid`);
    const body = g.panels?.body;
    need(Array.isArray(body) && body.length > 0, `${g.alliance} goal.panels.body missing`);
    for (const p of [...body, g.panels.blocker]) {
      need(p && Array.isArray(p.points) && p.points.length >= 3 && p.points.every(isVec3), `${g.alliance} goal panel ${p?.name} needs >= 3 [x,y,z] points`);
      need(isPlanar(p.points, tolIn), `${g.alliance} goal panel ${p.name} is not planar`);
    }
  }

  // Floor markings (optional section; validated when present)
  const markings: Marking[] = [];
  for (const mk of r.markings?.lines ?? []) {
    need(typeof mk.name === "string", "marking.name missing");
    need(mk.colour === "white" || mk.colour === "red" || mk.colour === "blue", `marking ${mk.name}: colour must be white|red|blue`);
    need(Array.isArray(mk.points) && mk.points.length >= 2 && mk.points.every(isVec3), `marking ${mk.name}: needs >= 2 [x,y,z] points`);
    need(mk.points.every((p: Vec3) => Math.abs(p[2]) < 1e-9), `marking ${mk.name}: must lie on the floor (z = 0)`);
    markings.push({ name: mk.name, colour: mk.colour, closed: !!mk.closed, points: mk.points });
  }

  const structureLines: { name: string; points: Vec3[] }[] = [];
  for (const sl of r.structureLines?.lines ?? []) {
    need(Array.isArray(sl.points) && sl.points.length >= 2 && sl.points.every(isVec3), `structure line ${sl.name}: needs >= 2 [x,y,z] points`);
    structureLines.push({ name: sl.name, points: sl.points });
  }

  return {
    structureLines,
    markings,
    perimeterCorners: pc.map((c: PerimeterCorner) => ({ label: c.label, nearest: c.nearest, point: c.point })),
    wallTopZ: r.field.wallTopZ,
    tilePitch: t.pitch,
    seamsX: t.seamsX,
    seamsY: t.seamsY,
    gridLinesX: t.gridLinesX,
    gridLinesY: t.gridLinesY,
    tagFamily: at.family,
    tagBlackSize: s,
    excludedTagIds: excluded,
    tags: at.tags.map((x: TagModel) => ({ id: x.id, goal: x.goal, centre: x.centre, corners: x.corners })),
    ramps: r.ramps.map((x: RampModel) => ({ alliance: x.alliance, surfaceCorners: x.surfaceCorners, clearanceHeight: x.clearanceHeight, lowerRampStart: x.lowerRampStart, gateEnd: x.gateEnd })),
    goals: r.goals.map((x: any) => ({ alliance: x.alliance, footprint: x.footprint, topLip: x.topLip, frontFace: x.frontFace, backboardTopZ: x.backboardTopZ, panels: { body: x.panels.body.map((p: any) => p.points), blocker: x.panels.blocker.points } })), // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

let cached: FieldModel | null = null;
export function getFieldModel(): FieldModel {
  if (!cached) cached = parseFieldModel(rawModel);
  return cached;
}

// ---- derived geometry -------------------------------------------------------

// The 8 points of a ramp's ROI volume: surface corners, then the same corners one
// ARTIFACT diameter higher.
export function rampVolume(r: RampModel): Vec3[] {
  const up = r.surfaceCorners.map((p) => [p[0], p[1], p[2] + r.clearanceHeight] as Vec3);
  return [...r.surfaceCorners, ...up];
}

// A point on the lower-RAMP centre-line `offsetIn` inches down-ramp from where
// ARTIFACTS land on it (towards the GATE), at half the clearance height (roughly an
// ARTIFACT's centre). offsetIn = 0 is the landing point; the ramp length is the GATE.
export function rampLinePoint(r: RampModel, offsetIn: number): Vec3 {
  const a = r.lowerRampStart;
  const b = r.gateEnd;
  const len = dist3(a, b);
  const t = Math.max(0, Math.min(1, offsetIn / len));
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + r.clearanceHeight / 2];
}

// Floor grid intersection points (z = 0) of the visible grid lines.
export function floorGridPoints(m: FieldModel): { world: Vec3; ix: number; iy: number }[] {
  const out: { world: Vec3; ix: number; iy: number }[] = [];
  m.gridLinesX.forEach((x, ix) => m.gridLinesY.forEach((y, iy) => out.push({ world: [x, y, 0], ix, iy })));
  return out;
}

// Reference point for a goal (footprint centroid at mid-height of the goal).
export function goalReferencePoint(g: GoalModel): Vec3 {
  const n = g.footprint.length;
  const x = g.footprint.reduce((s, p) => s + p[0], 0) / n;
  const y = g.footprint.reduce((s, p) => s + p[1], 0) / n;
  const z = g.topLip[0][2] / 2;
  return [x, y, z];
}

export function floorOutline(m: FieldModel): Vec2[] {
  return m.perimeterCorners.map((c) => [c.point[0], c.point[1]] as Vec2);
}
