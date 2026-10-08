// Field model: validation + geometric consistency with the manual.
// Run with: node --experimental-transform-types --test lib/scouting/placement/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import raw from "./field_model.json" with { type: "json" };
import { FieldModelError, getFieldModel, parseFieldModel, rampLinePoint } from "./fieldModel.ts";

const clone = () => JSON.parse(JSON.stringify(raw));

test("the shipped field model validates", () => {
  const m = getFieldModel();
  assert.equal(m.tags.length, 2);
  assert.equal(m.ramps.length, 2);
  assert.equal(m.perimeterCorners.length, 4);
});

test("tags are the manual's GOAL tags with 6.5 in black squares at 29.5 in", () => {
  const m = getFieldModel();
  assert.deepEqual(m.tags.map((t) => t.id).sort(), [20, 24]); // CM §9.10
  assert.equal(m.tagBlackSize, 6.5); // CM Fig 9-19
  for (const t of m.tags) assert.ok(Math.abs(t.centre[2] - (38.75 - 9.25)) < 0.01, `tag ${t.id} centre z ${t.centre[2]}`);
  assert.deepEqual(m.excludedTagIds, [21, 22, 23]); // OBELISK, CM §9.6
});

test("red GOAL/RAMP sit on the far-right from the audience (negative x in the field frame)", () => {
  const m = getFieldModel();
  const red = m.tags.find((t) => t.id === 24)!;
  assert.ok(red.centre[0] < 0 && red.centre[1] < 0);
  const redRamp = m.ramps.find((r) => r.alliance === "red")!;
  assert.ok(redRamp.surfaceCorners.every((p) => p[0] < -60));
  // ARTIFACTS enter high at the goal end and roll down to the GATE.
  assert.ok(rampLinePoint(redRamp, 0)[2] > rampLinePoint(redRamp, 1e6)[2]);
  // ROI region reaches up to the SQUARE end of the upper RAMP, above the landing point.
  assert.ok(redRamp.surfaceCorners[0][2] > redRamp.lowerRampStart[2]);
});

test("tile pitch and seams are consistent (6x6 grid)", () => {
  const m = getFieldModel();
  assert.equal(m.seamsX.length, 5);
  assert.equal(m.gridLinesX.length, 7);
  assert.ok(Math.abs(m.tilePitch - 23.563) < 0.01);
});

test("validation rejects a tag that is not a 6.5 in square", () => {
  const bad = clone();
  bad.apriltags.tags[0].corners[1][2] += 1;
  assert.throws(() => parseFieldModel(bad), FieldModelError);
});

test("validation rejects duplicate ramp corners", () => {
  const bad = clone();
  bad.ramps[0].surfaceCorners[2] = bad.ramps[0].surfaceCorners[1];
  assert.throws(() => parseFieldModel(bad), /not distinct/);
});

test("GOAL coloured panels: backboard 15 in above the 38.75 in top, blue mirrors red, blocker under the RAMP", () => {
  const m = getFieldModel();
  for (const g of m.goals) {
    const zs = g.panels.body.flat().map((p) => p[2]);
    assert.ok(Math.abs(Math.max(...zs) - (38.75 + 15)) < 0.05, `${g.alliance} backboard top ${Math.max(...zs)}`); // CM §9.7 Fig 9-9
    assert.ok(Math.abs(Math.min(...zs)) < 1e-9, "panels start on the TILE");
    const ramp = m.ramps.find((r) => r.alliance === g.alliance)!;
    // the blocker runs along the field side of the lower RAMP, below its rails
    const bx = g.panels.blocker.map((p) => p[0]);
    assert.ok(Math.max(...bx) - Math.min(...bx) < 0.01, "blocker is one vertical plane");
    assert.ok(Math.abs(bx[0]) < Math.min(...ramp.surfaceCorners.map((c) => Math.abs(c[0]))), "blocker is on the field side of the RAMP");
  }
  const red = m.goals.find((g) => g.alliance === "red")!;
  const blue = m.goals.find((g) => g.alliance === "blue")!;
  // CAD: the blue parts are the exact x -> -x mirror of the red ones
  red.panels.body.forEach((poly, i) =>
    poly.forEach((p, j) => {
      const q = blue.panels.body[i][j];
      assert.ok(Math.abs(p[0] + q[0]) < 1e-9 && p[1] === q[1] && p[2] === q[2], `panel ${i} point ${j} mirrored`);
    }),
  );
  assert.ok(red.panels.body.flat().every((p) => p[0] < 0));
});

test("validation rejects a non-planar GOAL panel", () => {
  const bad = clone();
  bad.goals[0].panels.body[0].points[2][0] += 3;
  assert.throws(() => parseFieldModel(bad), /not planar/);
});

test("validation rejects missing fields and wrong tag family", () => {
  const a = clone();
  delete a.tiles;
  assert.throws(() => parseFieldModel(a), FieldModelError);
  const b = clone();
  b.apriltags.family = "16h5";
  assert.throws(() => parseFieldModel(b), /36h11/);
  const c = clone();
  c.field.perimeterCorners.pop();
  assert.throws(() => parseFieldModel(c), /4 corners/);
});
