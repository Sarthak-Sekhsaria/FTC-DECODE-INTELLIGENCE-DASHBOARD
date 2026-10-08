// Generates lib/scouting/placement/field_model.json — the 3D DECODE field model
// used by Auto Scouting's automatic ROI placement.
//
//   node scripts/build-field-model.mjs
//
// SOURCES (nothing here is estimated or a "typical value"):
//   [CM]  2025-2026 FTC Competition Manual, Team Update 32 (docs/DECODE_Competition_Manual_TU32.pdf)
//   [CAD] Official DECODE field CAD, "DECODE presented by RTX Full Field STEP.20250905 - V1"
//         (am-5700_Full.step), linked from the official Playing Field Resources page:
//         https://ftc-resources.firstinspires.org/ftc/archive/2026/field  -> "Field CAD (STEP)".
//         CM §9.1 (p. 59): "The 3D CAD model is the official representation of the DECODE FIELD
//         and how it is constructed. Measurements may be taken from this model with a general
//         tolerance of +/- 1 in."
//   [FAC] Official Field Acceptance Checklist V25-26.2 (same resources page).
//
// The manual text/figures give the tag family, IDs, tag size, tag mounting height, goal height
// and tile size, but NOT the goal's x/y placement, the goal face angle, or ANY RAMP dimension —
// those come from the CAD (the manual itself names the CAD as the authority for them).
//
// CAD measurement method: the STEP file was loaded with OpenCascade (occt-import-js) and each
// named part's world-space vertices were measured (bounding boxes, plane fits, edge-line fits).
// CAD frame: millimetres, origin at field centre, z = 0 on the TILE top surface, CAD +y toward
// the GOAL wall (away from the audience), CAD +x toward the RED GOAL / blue ALLIANCE AREA side.
// All CAD numbers below are copied verbatim from that measurement run.

import fs from "node:fs";
import path from "node:path";

const MM_PER_IN = 25.4;

// ---------------------------------------------------------------------------
// Raw CAD measurements (mm, CAD frame)
// ---------------------------------------------------------------------------

// Perimeter inner wall faces = inner faces of the "FTC Rail with Rivet Holes am-2556a" rails. [CAD]
const WALL_CAD_POS_X = 1792.9; // rail inner face, CAD +x wall
const WALL_CAD_NEG_X = -1792.9; // rail inner face, CAD -x wall
const WALL_CAD_POS_Y = 1792.1; // rail inner face, GOAL wall (far from audience)
const WALL_CAD_NEG_Y = -1793.7; // rail inner face, audience wall
const WALL_TOP_Z = 295.7; // top of upper perimeter rail [CAD] (wall height is not stated in CM)

// Tile seams (the interlocking tab lines, CM §9.4 Fig 9-4). Each "Soft Tiles am-2499" part is
// 619.1 mm tab-to-tab and neighbouring tiles overlap over +/-10.3 mm around each seam, so the
// seams sit at 0, +/-598.5, +/-1197.0 mm (tile pitch 598.5 mm = 23.563 in). [CAD]
// CM §9.2 gives the nominal tile as "approximately 24 in." — the CAD value is used because the
// CAD is the official construction reference (CM §9.1).
const TILE_PITCH_CAD = 598.5;
const SEAMS_CAD = [-2, -1, 0, 1, 2].map((k) => k * TILE_PITCH_CAD);

// GOAL front panel ("Goal Front Panel, Red - am-5716_red"), field-facing surface. Plane fit of
// all panel vertices: panel is 10.0 mm thick, direction u = (0.587136, -0.809489). [CAD]
const RED_FRONT_FACE_END_BACKWALL = [1200.471, 1776.194]; // end against the GOAL-wall rear panel
const RED_FRONT_FACE_END_ARCHWAY = [1603.128, 1221.047]; // end at the archway / RAMP side
// Rear panels ("Goal Rear Panel, Red - am-5717_red") inner faces and the archway panel. [CAD]
const RED_GOAL_REAR_INNER_Y = 1782.1; // rear panel along the GOAL wall, inner face
const RED_GOAL_SIDE_INNER_X = 1782.9; // rear panel along the side wall, inner face
const RED_GOAL_ARCHWAY_Y = 1225.0; // "Goal Archway, Red - am-5730_red", ramp-facing face
const GOAL_TOP_LIP_Z = 984.2; // top of front panel [CAD]; CM §9.7 / Fig 9-9 & FAC 1.8: 38.75 in
const GOAL_BACKBOARD_TOP_Z = 1365.2; // [CAD]; CM §9.7 / Fig 9-9: 15 in above the open top

// ALLIANCE-COLOURED PANELS of each GOAL / RAMP assembly — the large red / blue shapes that
// are visible from every camera angle. Outline of each panel's field-facing face, measured as
// the convex hull of the part's vertices projected onto its plane (corner fillets dropped). [CAD]
// Red side listed; the blue parts ("..., Blue - am-57xx_blue") are the exact x -> -x mirror.
const RED_GOAL_PANELS_CAD = [
  // "Goal Front Panel, Red - am-5716_red": the diagonal face (with the AprilTag), 0 .. 984.2 mm.
  { name: "front panel", part: "am-5716_red", pts: [[...RED_FRONT_FACE_END_BACKWALL, 0], [...RED_FRONT_FACE_END_ARCHWAY, 0], [...RED_FRONT_FACE_END_ARCHWAY, GOAL_TOP_LIP_Z], [...RED_FRONT_FACE_END_BACKWALL, GOAL_TOP_LIP_Z]] },
  // "Goal Rear Panel, Red - am-5717_red" along the side wall: inner face x 1782.9, y 1106.3 .. 1792.1, z 0 .. 984.2.
  { name: "side rear panel", part: "am-5717_red", pts: [[1782.9, 1106.3, 0], [1782.9, 1792.1, 0], [1782.9, 1792.1, 984.2], [1782.9, 1106.3, 984.2]] },
  // "Goal Rear Panel, Red - am-5717_red" along the GOAL wall: inner face y 1782.1, x 1097.1 .. 1782.9, z 0 .. 984.2.
  { name: "back rear panel", part: "am-5717_red", pts: [[1097.1, 1782.1, 0], [1782.9, 1782.1, 0], [1782.9, 1782.1, 984.2], [1097.1, 1782.1, 984.2]] },
  // "Goal Backboard Panel, Red - am-5718_red" on the side wall: y 1124.5 .. 1792.1 at z 984.2,
  // full height (1365.2) from y 1689 to the corner, sloping edge down to y 1124.5.
  { name: "side backboard", part: "am-5718_red", pts: [[1782.9, 1124.5, 984.2], [1782.9, 1792.1, 984.2], [1782.9, 1792.1, GOAL_BACKBOARD_TOP_Z], [1782.9, 1689.0, GOAL_BACKBOARD_TOP_Z]] },
  // "Goal Backboard Panel, Red - am-5718_red" on the GOAL wall: x 1115.3 .. 1782.9 at z 984.2,
  // full height from x 1679 to the corner.
  { name: "back backboard", part: "am-5718_red", pts: [[1115.3, 1782.1, 984.2], [1782.9, 1782.1, 984.2], [1782.9, 1782.1, GOAL_BACKBOARD_TOP_Z], [1679.0, 1782.1, GOAL_BACKBOARD_TOP_Z]] },
  // "Goal Archway, Red - am-5730_red" over the RAMP exit: face y 1225.0, x 1611.4 .. 1782.9, z 781.0 .. 984.2.
  { name: "archway", part: "am-5730_red", pts: [[1611.4, 1225.0, 781.0], [1782.9, 1225.0, 781.0], [1782.9, 1225.0, 984.2], [1611.4, 1225.0, 984.2]] },
];
// Lower-RAMP blockers: field-side face x 1602.3, under the lower RAMP, top edge following the
// RAMP slope. "Lower Ramp Blocker Small Section, Red - am-5735_red" (y -16.8 .. 631.4) and
// "Lower Ramp Blocker, Red - am-5731_red" (y 631.4 .. 1222.1) are coplanar and abut, so they are
// one panel: outline (y, z) (-16.8, 197) (54, 1.1) (1159, 1.1) (1222.1, 67) (1086, 504.6)
// (631.4, 385.6) (0, 220). [CAD]
const RED_BLOCKER_CAD = { name: "lower ramp blocker", part: "am-5735_red + am-5731_red", pts: [[-16.8, 197], [54, 1.1], [1159, 1.1], [1222.1, 67], [1086, 504.6], [631.4, 385.6], [0, 220]].map(([y, z]) => [1602.3, y, z]) };

// AprilTag placard ("Red Goal AprilTag Sticker - am-5707_id24"): plane fit of all vertices. [CAD]
// Centroid, in-plane horizontal direction u, outward normal n (pointing away from the field).
const RED_PLACARD_CENTROID = [1413.287, 1482.349];
const RED_PLACARD_U = [0.587136, -0.809489];
const RED_PLACARD_N = [0.809489, 0.587136];
const PLACARD_CENTRE_S = 0.4; // horizontal centre of the placard along u (s from -149.82 to 150.63)
const PLACARD_HALF_THICKNESS = 0.25; // placard is 0.51 mm thick; the tag is on its field side
// The blue side is the exact mirror (x -> -x) in the CAD: "Blue Goal AprilTag Sticker -
// am-5707_id20" centroid (-1413.287, 1482.349), u = (0.587136, 0.809489), n = (-0.809489, 0.587136).

// RAMP (lower RAMP, "Ramp 45in Two-Hole Extrusion - am-5733", 2 per RAMP): the two rails the
// CLASSIFIED ARTIFACTS roll on. Top edge of each rail fitted as z = a + b*y (both rails agree). [CAD]
const RAIL_TOP_A = 165.1;
const RAIL_TOP_B = 0.2798; // 15.63 deg slope
const RAIL_Y_GATE_END = -16.3; // rail end at the GATE
const RAIL_Y_GOAL_END = 1096.5; // rail end at the upper RAMP / GOAL
// Outer x extents of the rail pair (field-side face of inner rail, wall-side face of outer rail).
const RED_RAIL_X_FIELD_SIDE = 1621.2; // rails x 1621.2..1655.0 and 1735.5..1769.3
const RED_RAIL_X_WALL_SIDE = 1769.3;
const BLUE_RAIL_X_FIELD_SIDE = -1618.6; // rails x -1652.4..-1618.6 and -1766.7..-1732.9
const BLUE_RAIL_X_WALL_SIDE = -1766.7;
// Upper RAMP ("Ramp 28in Two-Hole Extrusion - am-5725", 2 per RAMP): runs inside the GOAL
// from the SQUARE (CM §9.8.1, at the GOAL-wall end) down to where ARTIFACTS drop onto the
// lower RAMP. Top edge fit z = 290.9 + 0.2785*y (both rails agree), y 1084.8 .. 1780.5. [CAD]
const UPPER_RAIL_TOP_A = 290.9;
const UPPER_RAIL_TOP_B = 0.2785; // 15.56 deg
const UPPER_RAIL_Y_SQUARE_END = 1780.5;
const RED_UPPER_RAIL_X_FIELD_SIDE = 1619.9; // rails x 1619.9..1653.7 and 1734.2..1768.0
const RED_UPPER_RAIL_X_WALL_SIDE = 1768.0;
const BLUE_UPPER_RAIL_X_FIELD_SIDE = -1619.9; // rails x -1653.7..-1619.9 and -1768.0..-1734.2
const BLUE_UPPER_RAIL_X_WALL_SIDE = -1768.0;

// RAISED STRUCTURE LINES — bright aluminium edges that are visible in most footage and,
// being off the floor, pin down camera height / FOV (a floor-only fit cannot). [CAD]
//  - lower-RAMP rails ("Ramp 45in Two-Hole Extrusion - am-5733"): rail-top centre-lines,
//    z = 165.1 + 0.2798*y, y -16.3 .. 1096.5; x centres red 1638.1 / 1752.4, blue -1635.5 / -1749.8
//  - RAMP guard rails ("Ramp 45in One-Hole Extrusion - am-5734"): top z = 346.4 + 0.2811*y,
//    y -61.5 .. 1046.4; x centres red 1624.15 / 1765.1, blue -1622.85 / -1763.85
//  - perimeter top rails ("FTC Rail with Rivet Holes am-2556a"): top z 295.7 along the inner wall faces
const GUARD_TOP_A = 346.4;
const GUARD_TOP_B = 0.2811;
const GUARD_Y0 = -61.5;
const GUARD_Y1 = 1046.4;
function structureLinesCad() {
  const rail = (x, name) => ({ name, pts: [[x, RAIL_Y_GATE_END, RAIL_TOP_A + RAIL_TOP_B * RAIL_Y_GATE_END], [x, RAIL_Y_GOAL_END, RAIL_TOP_A + RAIL_TOP_B * RAIL_Y_GOAL_END]] });
  const guard = (x, name) => ({ name, pts: [[x, GUARD_Y0, GUARD_TOP_A + GUARD_TOP_B * GUARD_Y0], [x, GUARD_Y1, GUARD_TOP_A + GUARD_TOP_B * GUARD_Y1]] });
  const c = [[WALL_CAD_POS_X, WALL_CAD_POS_Y], [WALL_CAD_POS_X, WALL_CAD_NEG_Y], [WALL_CAD_NEG_X, WALL_CAD_NEG_Y], [WALL_CAD_NEG_X, WALL_CAD_POS_Y]];
  const walls = c.map((p, i) => ({ name: `perimeter top rail ${i + 1}`, pts: [[p[0], p[1], WALL_TOP_Z], [c[(i + 1) % 4][0], c[(i + 1) % 4][1], WALL_TOP_Z]] }));
  return [
    rail(1638.1, "red lower ramp rail (field side)"),
    rail(1752.4, "red lower ramp rail (wall side)"),
    rail(-1635.5, "blue lower ramp rail (field side)"),
    rail(-1749.8, "blue lower ramp rail (wall side)"),
    guard(1624.15, "red ramp guard rail (field side)"),
    guard(1765.1, "red ramp guard rail (wall side)"),
    guard(-1622.85, "blue ramp guard rail (field side)"),
    guard(-1763.85, "blue ramp guard rail (wall side)"),
    ...walls,
  ];
}

// FLOOR MARKINGS (tape) — centre-lines of every "Taped Field" tape part, from the
// upward-facing faces of each tape mesh: the centre-line is the midpoint between the
// two parallel tape edges (all tapes are 1 in / 25.4 mm wide, CM §9.3). [CAD]
// Cross-checked against the Field Acceptance Checklist (FAC section 3).
const MARKINGS_CAD = [
  // Back LAUNCH LINE "V": apex over TILE intersection X3 = field centre, arms to the
  // far FIELD corners (FAC 3.2; CM §9.3 Fig 9-2). Edges: apex (0.79, 21.93)/(0.79,-13.99),
  // ends (-1789.91,1776.71)/(-1771.95,1794.67) and (1791.49,1776.71)/(1773.53,1794.67).
  { name: "back launch line", colour: "white", pts: [[-1780.93, 1785.69], [0.79, 3.97], [1782.51, 1785.69]], ref: "FAC §3 BACK LAUNCH LINE: V apex centred over TILE intersection X3, lines centred over FIELD corners" },
  // Front LAUNCH LINE "V": apex over X1, arms to the near TILE edge at seams W/Y (FAC 3.3).
  // Edges: apex (0.79,-1214.14)/(0.79,-1178.22); ends (-589.76,-1768.77)/(-571.80,-1786.73)
  // and (591.34,-1768.77)/(573.38,-1786.73).
  { name: "front launch line", colour: "white", pts: [[-580.78, -1777.75], [0.79, -1196.18], [582.36, -1777.75]], ref: "FAC §3 FRONT LAUNCH LINE: V apex centred over TILE intersection X1, lines end at the TILE edge at seams W/Y" },
  // BASE ZONES: 18 in squares (CM §9.3, FAC 3.4-3.6). Outer/inner edges
  // red x -1066.01/-1040.61 .. -608.81/-634.21, y -1186.66/-1161.26 .. -729.46/-754.86.
  { name: "red base zone", colour: "red", closed: true, pts: [[-1053.31, -1173.96], [-621.51, -1173.96], [-621.51, -742.16], [-1053.31, -742.16]], ref: "FAC §3 BASE ZONES: 18 in square adjacent to seams W and 1" },
  // blue x 610.39/635.79 .. 1067.59/1042.19, same y.
  { name: "blue base zone", colour: "blue", closed: true, pts: [[623.09, -1173.96], [1054.89, -1173.96], [1054.89, -742.16], [623.09, -742.16]], ref: "FAC §3 BASE ZONES: 18 in square adjacent to seams Y and 1" },
  // SPIKE MARKS: 10 in lines (CM §9.3, FAC 3.7-3.9), each 25.4 mm tall in y.
  { name: "red front spike mark", colour: "white", pts: [[-1326.36, -896.14], [-1072.36, -896.14]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  { name: "red centre spike mark", colour: "white", pts: [[-1326.36, -296.07], [-1072.36, -296.07]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  { name: "red back spike mark", colour: "white", pts: [[-1326.36, 304.01], [-1072.36, 304.01]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  { name: "blue front spike mark", colour: "white", pts: [[1073.94, -896.14], [1327.94, -896.14]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  { name: "blue centre spike mark", colour: "white", pts: [[1073.94, -296.07], [1327.94, -296.07]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  { name: "blue back spike mark", colour: "white", pts: [[1073.94, 304.01], [1327.94, 304.01]], ref: "FAC §3 SPIKE MARKS: 10 in, centred on the TILE, aligned with the grid" },
  // GATE ZONES: pairs of 10 in alliance-coloured lines adjacent to each GATE (CM §9.3, FAC 3.10-3.13).
  { name: "red gate zone (1)", colour: "red", pts: [[1207.29, 23.02], [1461.29, 23.02]], ref: "FAC §3 GATE ZONE: 10 in red lines adjacent to seams Z and 3" },
  { name: "red gate zone (2)", colour: "red", pts: [[1207.29, -23.02], [1461.29, -23.02]], ref: "FAC §3 GATE ZONE: 10 in red lines adjacent to seams Z and 3" },
  { name: "blue gate zone (1)", colour: "blue", pts: [[-1461.29, 23.02], [-1207.29, 23.02]], ref: "FAC §3 GATE ZONE: 10 in blue lines adjacent to seams V and 3" },
  { name: "blue gate zone (2)", colour: "blue", pts: [[-1461.29, -23.02], [-1207.29, -23.02]], ref: "FAC §3 GATE ZONE: 10 in blue lines adjacent to seams V and 3" },
  // SECRET TUNNEL ZONE lines, 16.75 in from seam V/Z, from seam 3 to seam 1 (FAC 3.18-3.21).
  { name: "red secret tunnel", colour: "red", pts: [[-1645.44, -10.32], [-1645.44, -1191.42]], ref: "FAC §3 SECRET TUNNEL ZONE: red tape 16.75 in from seam V, ends at seams 3 and 1" },
  { name: "blue secret tunnel", colour: "blue", pts: [[1645.44, -10.32], [1645.44, -1191.42]], ref: "FAC §3 SECRET TUNNEL ZONE: blue tape 16.75 in from seam Z, ends at seams 3 and 1" },
  // LOADING ZONES: white L in the audience-side corners (CM §9.3, FAC 3.14-3.17).
  { name: "red loading zone", colour: "white", pts: [[-1788.32, -1219.99], [-1219.99, -1219.99], [-1219.99, -1788.32]], ref: "FAC §3 LOADING ZONES: red zone adjacent to seams V and 1" },
  { name: "blue loading zone", colour: "white", pts: [[1788.32, -1219.99], [1219.99, -1219.99], [1219.99, -1788.32]], ref: "FAC §3 LOADING ZONES: blue zone adjacent to seams Z and 1" },
];

// ---------------------------------------------------------------------------
// Values stated directly in the Competition Manual
// ---------------------------------------------------------------------------
const TAG_FAMILY = "36h11"; // CM §9.10 p.74
const TAG_TOTAL_SIZE_IN = 8.125; // CM §9.10 p.74 ("8.125 in. square targets")
const TAG_BLACK_SIZE_IN = 6.5; // CM §9.10 Fig 9-19 p.75 ("6.5 in. square"), = 8 of the 10 cells
const TAG_CENTRE_BELOW_TOP_IN = 9.25; // CM §9.10 Fig 9-19 p.75
const RED_GOAL_TAG_ID = 24; // CM §9.10 p.74, FAC 1.16
const BLUE_GOAL_TAG_ID = 20; // CM §9.10 p.74, FAC 1.16
const ARTIFACT_DIAMETER_IN = 5; // CM §9.9 p.73 ("5 in. (12.70 cm) nominal")
const RAMP_CAPACITY = 9; // CM §9.8.2 p.69

// ---------------------------------------------------------------------------
// CAD -> field frame
// ---------------------------------------------------------------------------
// Field frame (as requested): inches, origin at field centre, +x toward the RED ALLIANCE AREA
// (CM §9.5: red ALLIANCE AREA is on the left from the audience), +z up, +y completes a
// right-handed frame and therefore points toward the AUDIENCE. This is the CAD frame rotated
// 180 deg about z:  x = -xCAD, y = -yCAD, z = zCAD.
const r3 = (v) => Math.round(v * 1000) / 1000;
const toField = ([x, y, z]) => [r3(-x / MM_PER_IN), r3(-y / MM_PER_IN), r3(z / MM_PER_IN)];
const mirrorX = ([x, y]) => [-x, y];

// Tag corners in the detector's order: the 4 corners of the tag's outer BLACK square in the
// order OpenCV's ArucoDetector (DICT_APRILTAG_36h11) returns them for the GOAL placards on a real
// field, which is [bottom-right, bottom-left, top-left, top-right] as seen looking at the tag face
// (clockwise in the image, starting bottom-right). Measured on 12 match videos at 9 venues (both
// GOAL tags, ~60 detections): with this order the placed pose reprojects the detected corners
// within 0.4-4 px; starting at the top-left instead (the order for OpenCV's own rendering of the
// marker) leaves them 18-66 px apart — the printed tags are rotated 180 deg from that rendering.
function tagCornersCad(centroid, u, n, id) {
  const cx = centroid[0] + u[0] * PLACARD_CENTRE_S - n[0] * PLACARD_HALF_THICKNESS;
  const cy = centroid[1] + u[1] * PLACARD_CENTRE_S - n[1] * PLACARD_HALF_THICKNESS;
  const cz = GOAL_TOP_LIP_Z - TAG_CENTRE_BELOW_TOP_IN * MM_PER_IN;
  // A viewer on the field looks along +n; their right-hand direction is n x z = (n.y, -n.x, 0).
  const right = [n[1], -n[0]];
  const h = (TAG_BLACK_SIZE_IN * MM_PER_IN) / 2;
  const P = (sr, sz) => [cx + right[0] * h * sr, cy + right[1] * h * sr, cz + h * sz];
  return { id, centre: [cx, cy, cz], corners: [P(1, -1), P(-1, -1), P(-1, 1), P(1, 1)] };
}

const redTag = tagCornersCad(RED_PLACARD_CENTROID, RED_PLACARD_U, RED_PLACARD_N, RED_GOAL_TAG_ID);
const blueTag = tagCornersCad(
  mirrorX(RED_PLACARD_CENTROID),
  [RED_PLACARD_U[0], -RED_PLACARD_U[1]],
  [-RED_PLACARD_N[0], RED_PLACARD_N[1]],
  BLUE_GOAL_TAG_ID,
);

function railTopZ(y) {
  return RAIL_TOP_A + RAIL_TOP_B * y;
}
function upperRailTopZ(y) {
  return UPPER_RAIL_TOP_A + UPPER_RAIL_TOP_B * y;
}
// ROI region: the whole artifact path, from the SQUARE end of the upper RAMP (inside the
// GOAL) to the GATE end of the lower RAMP. Covering the upper part means an ARTIFACT is
// already seen on the goal side of the scoring line before it crosses it, which is what
// the (unchanged) crossing counter needs.
function rampCornersCad(xFieldUp, xWallUp, xFieldLow, xWallLow) {
  // Order: goal (SQUARE) end field side, goal end wall side, gate end wall side, gate end field side.
  return [
    [xFieldUp, UPPER_RAIL_Y_SQUARE_END, upperRailTopZ(UPPER_RAIL_Y_SQUARE_END)],
    [xWallUp, UPPER_RAIL_Y_SQUARE_END, upperRailTopZ(UPPER_RAIL_Y_SQUARE_END)],
    [xWallLow, RAIL_Y_GATE_END, railTopZ(RAIL_Y_GATE_END)],
    [xFieldLow, RAIL_Y_GATE_END, railTopZ(RAIL_Y_GATE_END)],
  ];
}
// Centre of the lower RAMP where it starts (ARTIFACTS land here after leaving the GOAL)
// and at the GATE end — the scoring line is placed between these.
function lowerRampCentreCad(xField, xWall, y) {
  return [(xField + xWall) / 2, y, railTopZ(y)];
}

function goalOutlineCad(sign) {
  const m = ([x, y]) => [sign * x, y];
  // Footprint polygon, going around the GOAL: front face (both ends), archway, side wall corner,
  // GOAL-wall corner.
  return [
    m(RED_FRONT_FACE_END_BACKWALL),
    m(RED_FRONT_FACE_END_ARCHWAY),
    m([RED_GOAL_SIDE_INNER_X, RED_GOAL_ARCHWAY_Y]),
    m([RED_GOAL_SIDE_INNER_X, RED_GOAL_REAR_INNER_Y]),
    m([RED_FRONT_FACE_END_BACKWALL[0], RED_GOAL_REAR_INNER_Y]),
  ];
}

const pt = (v) => toField(v.length === 2 ? [v[0], v[1], 0] : v);
const withZ = (poly, z) => poly.map(([x, y]) => toField([x, y, z]));

const CAD_SRC = "[CAD] official DECODE field STEP (am-5700_Full), CM §9.1 names the CAD the official reference";
const model = {
  $schema: "field_model v1",
  description:
    "DECODE (2025-2026) field model for Auto Scouting ROI placement. Generated by scripts/build-field-model.mjs — do not edit by hand.",
  coordinateSystem: {
    units: "inches",
    origin: "centre of the FIELD, z = 0 on the TILE top surface",
    x: "toward the RED ALLIANCE AREA side wall (CM §9.5: red ALLIANCE AREA is on the left as seen from the audience). NOTE: the RED GOAL/RAMP is therefore at NEGATIVE x (far-right corner from the audience, CM Fig 9-18), the BLUE GOAL/RAMP at positive x.",
    y: "completes a right-handed frame: points toward the AUDIENCE. Both GOALS are at negative y.",
    z: "up",
    derivedFromCad: "x = -xCAD/25.4, y = -yCAD/25.4, z = zCAD/25.4 (CAD is mm, +y toward the GOAL wall)",
  },
  sources: {
    CM: "2025-2026 FIRST Tech Challenge Competition Manual, Team Update 32 (docs/DECODE_Competition_Manual_TU32.pdf)",
    CAD: "Official DECODE field CAD 'DECODE presented by RTX Full Field STEP.20250905 - V1' (am-5700_Full.step) from https://ftc-resources.firstinspires.org/ftc/archive/2026/field — CM §9.1 p.59 names this CAD the official representation (±1 in)",
    FAC: "Official Field Acceptance Checklist V25-26.2 (same page)",
  },
  field: {
    perimeterCorners: [
      {
        label: "red-goal corner (GOAL wall, blue ALLIANCE AREA side)",
        nearest: "red GOAL",
        point: pt([WALL_CAD_POS_X, WALL_CAD_POS_Y]),
        source: `${CAD_SRC}: inner faces of perimeter rails am-2556a; red GOAL in this corner per CM Fig 9-18`,
      },
      {
        label: "blue loading-zone corner (audience wall, blue ALLIANCE AREA side)",
        nearest: "blue LOADING ZONE",
        point: pt([WALL_CAD_POS_X, WALL_CAD_NEG_Y]),
        source: `${CAD_SRC}: inner faces of perimeter rails am-2556a; CM Fig 9-2 LOADING ZONE -BLUE`,
      },
      {
        label: "red loading-zone corner (audience wall, red ALLIANCE AREA side)",
        nearest: "red LOADING ZONE",
        point: pt([WALL_CAD_NEG_X, WALL_CAD_NEG_Y]),
        source: `${CAD_SRC}: inner faces of perimeter rails am-2556a; CM Fig 9-2 LOADING ZONE -RED`,
      },
      {
        label: "blue-goal corner (GOAL wall, red ALLIANCE AREA side)",
        nearest: "blue GOAL",
        point: pt([WALL_CAD_NEG_X, WALL_CAD_POS_Y]),
        source: `${CAD_SRC}: inner faces of perimeter rails am-2556a; blue GOAL in this corner per CM Fig 9-18`,
      },
    ],
    perimeterCornerOrder:
      "Starts at the corner nearest the red GOAL and goes clockwise as seen from above (the 4-tap order).",
    wallTopZ: r3(WALL_TOP_Z / MM_PER_IN),
    wallTopZSource: `${CAD_SRC}: top of upper rail am-2556a (CM does not state wall height; used for debug drawing only)`,
    nominalSizeIn: 144,
    nominalSizeSource: "CM §9.2 p.60: 'approximately 144 in. by 144 in.' (CAD inner size is used for geometry)",
  },
  tiles: {
    count: [6, 6],
    countSource: "CM §9.2 p.60: 36 TILES; CM §9.4 Fig 9-5: 6 x 6 grid",
    pitch: r3(TILE_PITCH_CAD / MM_PER_IN),
    pitchSource: `${CAD_SRC}: am-2499 tiles 619.1 mm tab-to-tab overlapping ±10.3 mm -> 598.5 mm pitch (CM §9.2 nominal 'approximately 24 in.')`,
    seamsX: SEAMS_CAD.map((s) => r3(-s / MM_PER_IN)).sort((a, b) => a - b),
    seamsY: SEAMS_CAD.map((s) => r3(-s / MM_PER_IN)).sort((a, b) => a - b),
    seamSource: `${CAD_SRC}: tab interlock lines (CM §9.4 Fig 9-4 'TILE tab-line locations')`,
    gridLinesX: [r3(-WALL_CAD_POS_X / MM_PER_IN), ...SEAMS_CAD.map((s) => r3(-s / MM_PER_IN)).sort((a, b) => a - b), r3(-WALL_CAD_NEG_X / MM_PER_IN)],
    gridLinesY: [r3(-WALL_CAD_POS_Y / MM_PER_IN), ...SEAMS_CAD.map((s) => r3(-s / MM_PER_IN)).sort((a, b) => a - b), r3(-WALL_CAD_NEG_Y / MM_PER_IN)],
    gridLinesNote:
      "gridLinesX/Y = the 5 interior seams plus the two floor/wall boundaries, i.e. the straight lines visible on the floor (used by the field-plane placement method).",
  },
  apriltags: {
    family: TAG_FAMILY,
    familySource: "CM §9.10 p.74",
    totalSize: TAG_TOTAL_SIZE_IN,
    totalSizeSource: "CM §9.10 p.74 ('8.125 in. (~20.65 cm) square targets')",
    blackSquareSize: TAG_BLACK_SIZE_IN,
    blackSquareSizeSource: "CM §9.10 Fig 9-19 p.75 ('6.5 in. square'); the corners below are of this black square",
    cornerOrder:
      "[bottom-right, bottom-left, top-left, top-right] of the tag's outer black square, as seen facing the tag — the order OpenCV's ArucoDetector (DICT_APRILTAG_36h11) returns for the printed GOAL tags (measured on 12 match videos; see scripts/build-field-model.mjs).",
    excluded: {
      ids: [21, 22, 23],
      reason: "OBELISK tags — CM §9.6 p.65: 'The location of the OBELISK is not intended to be deterministic relative to the field coordinate system and should not be used for navigation.'",
    },
    tags: [redTag, blueTag].map((t) => ({
      id: t.id,
      goal: t.id === RED_GOAL_TAG_ID ? "red" : "blue",
      idSource: "CM §9.10 p.74 (red GOAL ID 24, blue GOAL ID 20); FAC 1.16",
      centre: toField(t.centre),
      corners: t.corners.map(toField),
      placementSource:
        `CM §9.10 Fig 9-19 p.75: centred on the GOAL front face, centre 9.25 in. below the top edge of the front panel; top edge 38.75 in. above the TILE (CM §9.7, FAC 1.8) -> centre z = 29.5 in. Face plane and horizontal centre from ${CAD_SRC} (placard am-5707_id${t.id} plane fit).`,
    })),
  },
  ramps: [
    { alliance: "red", xField: RED_RAIL_X_FIELD_SIDE, xWall: RED_RAIL_X_WALL_SIDE, xFieldUp: RED_UPPER_RAIL_X_FIELD_SIDE, xWallUp: RED_UPPER_RAIL_X_WALL_SIDE },
    { alliance: "blue", xField: BLUE_RAIL_X_FIELD_SIDE, xWall: BLUE_RAIL_X_WALL_SIDE, xFieldUp: BLUE_UPPER_RAIL_X_FIELD_SIDE, xWallUp: BLUE_UPPER_RAIL_X_WALL_SIDE },
  ].map((r) => ({
    alliance: r.alliance,
    cornerOrder: "[goal (SQUARE) end field side, goal end wall side, gate end wall side, gate end field side]",
    surfaceCorners: rampCornersCad(r.xFieldUp, r.xWallUp, r.xField, r.xWall).map(toField),
    surfaceSource: `${CAD_SRC}: rail tops of the upper RAMP 'Ramp 28in Two-Hole Extrusion - am-5725' (z = 290.9 + 0.2785*yCAD mm) at its SQUARE end yCAD 1780.5, and of the lower RAMP 'Ramp 45in Two-Hole Extrusion - am-5733' (z = 165.1 + 0.2798*yCAD mm, 15.6 deg) at its GATE end yCAD -16.3; outer x faces of each rail pair. The lower RAMP (yCAD -16.3..1096.5) holds the ${RAMP_CAPACITY} CLASSIFIED ARTIFACTS (CM §9.8.2).`,
    lowerRampStart: toField(lowerRampCentreCad(r.xField, r.xWall, RAIL_Y_GOAL_END)),
    gateEnd: toField(lowerRampCentreCad(r.xField, r.xWall, RAIL_Y_GATE_END)),
    lineAnchorsSource: `${CAD_SRC}: centre of the lower-RAMP rail pair at its GOAL end (yCAD 1096.5, where ARTIFACTS land after leaving the GOAL) and at its GATE end (yCAD -16.3)`,
    clearanceHeight: ARTIFACT_DIAMETER_IN,
    clearanceSource: "CM §9.9 p.73: ARTIFACTS are 5 in. nominal — the ROI volume extends one ARTIFACT above the rail tops",
    entryEnd: "goal",
    entryEndNote: "ARTIFACTS enter at the goal end (from the SQUARE, CM §9.8.1) and roll toward the GATE (CM §9.8.3).",
  })),
  markings: {
    tapeWidth: 1,
    tapeWidthSource: "CM §9.3 p.61: 1 in. (2.50 cm) wide gaffers tape in red, electric blue and white",
    note: "Tape centre-lines on the floor (z = 0). Used by the field-plane placement method: at broadcast resolution the TILE seams are usually invisible but these markings are crisp.",
    lines: MARKINGS_CAD.map((m) => ({
      name: m.name,
      colour: m.colour,
      closed: !!m.closed,
      points: m.pts.map((p) => toField([p[0], p[1], 0])),
      source: `${CAD_SRC}: 'Taped Field' tape part, centre-line between its two edges; ${m.ref}`,
    })),
  },
  structureLines: {
    note: "Raised, bright metal edges (RAMP rails, RAMP guard rails, perimeter top rails). Used alongside the floor tape by the field-plane placement method; being off the floor they fix camera height / FOV.",
    lines: structureLinesCad().map((l) => ({
      name: l.name,
      points: l.pts.map(toField),
      source: `${CAD_SRC}: ${l.name.includes("perimeter") ? "top of perimeter rail am-2556a (z 295.7 mm) on the inner wall face" : l.name.includes("guard") ? "top edge of RAMP guard rail am-5734 (z = 346.4 + 0.2811*yCAD mm)" : "top edge of lower-RAMP rail am-5733 (z = 165.1 + 0.2798*yCAD mm)"}`,
    })),
  },
  goals: ["red", "blue"].map((alliance) => {
    const sign = alliance === "red" ? 1 : -1;
    const poly = goalOutlineCad(sign);
    return {
      alliance,
      footprint: withZ(poly, 0),
      topLip: withZ(poly, GOAL_TOP_LIP_Z),
      frontFace: [pt(poly[0]), pt(poly[1]), toField([...poly[1], GOAL_TOP_LIP_Z]), toField([...poly[0], GOAL_TOP_LIP_Z])],
      backboardTopZ: r3(GOAL_BACKBOARD_TOP_Z / MM_PER_IN),
      // Alliance-coloured panels: the GOAL body (convex as a group) and the lower-RAMP blocker.
      panels: {
        body: RED_GOAL_PANELS_CAD.map((p) => ({ name: p.name, points: p.pts.map(([x, y, z]) => toField([sign * x, y, z])), source: `${CAD_SRC}: ${p.part.replace(/_red/g, `_${alliance}`)} face outline` })),
        blocker: { name: RED_BLOCKER_CAD.name, points: RED_BLOCKER_CAD.pts.map(([x, y, z]) => toField([sign * x, y, z])), source: `${CAD_SRC}: ${RED_BLOCKER_CAD.part.replace(/_red/g, `_${alliance}`)} field-side face outline` },
      },
      source: `${CAD_SRC}: Goal Front/Rear/Archway panels am-5716/5717/5730; top lip 38.75 in (CM §9.7 Fig 9-9, FAC 1.8); backboard 15 in above the top (CM Fig 9-9)`,
    };
  }),
};

const out = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..", "lib", "scouting", "placement", "field_model.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(model, null, 2) + "\n");
console.log("wrote", out);
