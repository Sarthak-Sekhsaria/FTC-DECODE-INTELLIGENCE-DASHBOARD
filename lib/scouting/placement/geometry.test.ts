import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyH,
  cameraCentre,
  clipToRect,
  convexHull,
  homography4,
  intrinsicsFromFov,
  isConvex,
  lookAt,
  median,
  nonCollinear,
  polygonArea,
  projectPoint,
  rodrigues,
  rotationToRodrigues,
  type Vec2,
} from "./geometry.ts";

test("intrinsics from FOV: 90° -> f = W/2, principal point at centre", () => {
  const K = intrinsicsFromFov(1000, 500, 90);
  assert.ok(Math.abs(K.fx - 500) < 1e-9);
  assert.equal(K.cx, 500);
  assert.equal(K.cy, 250);
});

test("rodrigues round-trips, including 180° rotations", () => {
  for (const r of [[0.1, -0.2, 0.3], [Math.PI, 0, 0], [0, Math.PI * 0.7071, Math.PI * 0.7071], [0, 0, 3.1414]] as [number, number, number][]) {
    const R = rodrigues(r);
    const R2 = rodrigues(rotationToRodrigues(R));
    R.forEach((v, i) => assert.ok(Math.abs(v - R2[i]) < 1e-6, `r=${r} idx ${i}`));
  }
});

test("lookAt puts the target at the image centre and the camera at eye", () => {
  const pose = lookAt([10, 150, 90], [0, -20, 0]);
  const K = intrinsicsFromFov(1280, 720, 60);
  const p = projectPoint([0, -20, 0], pose, K);
  assert.ok(Math.abs(p.uv[0] - 640) < 1e-6 && Math.abs(p.uv[1] - 360) < 1e-6);
  const c = cameraCentre(pose);
  assert.ok(Math.hypot(c[0] - 10, c[1] - 150, c[2] - 90) < 1e-6);
  // world up must be image up
  const up = projectPoint([0, -20, 10], pose, K);
  assert.ok(up.uv[1] < 360);
});

test("convexity, area, hull and clipping", () => {
  const sq: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(isConvex(sq));
  assert.ok(!isConvex([[0, 0], [10, 10], [10, 0], [0, 10]])); // bow-tie
  assert.equal(polygonArea(sq), 100);
  assert.equal(convexHull([...sq, [5, 5]]).length, 4);
  assert.equal(polygonArea(clipToRect([[-5, -5], [5, -5], [5, 5], [-5, 5]], 100, 100)), 25);
});

test("4-point homography maps its sources exactly", () => {
  const src: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const dst: Vec2[] = [[10, 10], [50, 12], [48, 60], [8, 55]];
  const H = homography4(src, dst)!;
  src.forEach((s, i) => {
    const p = applyH(H, s)!;
    assert.ok(Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < 1e-6);
  });
});

test("median ignores outliers; collinearity check", () => {
  assert.equal(median([1, 2, 3, 100, 2]), 2);
  assert.ok(!nonCollinear([[0, 0], [1, 1], [2, 2], [3, 3]]));
  assert.ok(nonCollinear([[0, 0], [10, 0], [0, 10], [10, 10]]));
});
