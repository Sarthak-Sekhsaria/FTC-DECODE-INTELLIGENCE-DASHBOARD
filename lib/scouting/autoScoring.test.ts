// Tests for Auto Scouting score derivation (computeAllianceScore). Phase-free:
// every accepted artifact event counts the same regardless of video time. Covers
// rejected exclusion, manual/added events, RED/BLUE separation, artifact point
// values, pattern, leave, and endgame BASE math.
//
// Run with:  node --experimental-transform-types --test lib/scouting/autoScoring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAllianceScore,
  emptyManualEntry,
  artifactPointsFor,
  type ScoreEvent,
} from "./autoTypes.ts";

function ev(partial: Partial<ScoreEvent>): ScoreEvent {
  return {
    id: Math.random().toString(36),
    videoTime: 5,
    alliance: "red",
    type: "classified",
    color: "purple",
    points: artifactPointsFor(partial.type ?? "classified"),
    method: "cv",
    status: "auto",
    confidence: "high",
    ...partial,
  };
}

test("classified is worth 3 and overflow is worth 1 (official manual)", () => {
  assert.equal(artifactPointsFor("classified"), 3);
  assert.equal(artifactPointsFor("overflow"), 1);
});

test("rejected events are excluded from the score", () => {
  const events = [ev({ status: "auto" }), ev({ status: "rejected" })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.artifacts, 1);
  assert.equal(score.artifactPoints, 3);
});

test("a manually added confirmed event updates the total", () => {
  const events = [ev({ method: "manual", status: "confirmed" })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.total, 3);
});

test("artifact points and count sum across all events regardless of timestamp", () => {
  const events = [ev({ videoTime: 2 }), ev({ videoTime: 120 }), ev({ videoTime: 300 })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.artifacts, 3);
  assert.equal(score.artifactPoints, 9);
});

test("three artifacts crossing together give +9", () => {
  const events = [ev({ videoTime: 8.4 }), ev({ videoTime: 8.4 }), ev({ videoTime: 8.5 })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.artifactPoints, 9);
});

test("a merged-clump event (count>1) counts as several artifacts", () => {
  // one event representing a 3-ball clump: points 9, count 3
  const events = [ev({ points: 9, count: 3 })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.artifacts, 3);
  assert.equal(score.artifactPoints, 9);
});

test("RED and BLUE scores stay separate", () => {
  const events = [ev({ alliance: "red" }), ev({ alliance: "blue" }), ev({ alliance: "blue" })];
  const red = computeAllianceScore("red", events, emptyManualEntry());
  const blue = computeAllianceScore("blue", events, emptyManualEntry());
  assert.equal(red.artifacts, 1);
  assert.equal(blue.artifacts, 2);
});

test("an overflow correction lowers artifact points to 1 for that event", () => {
  const events = [ev({ type: "classified" }), ev({ type: "overflow" })];
  const score = computeAllianceScore("red", events, emptyManualEntry());
  assert.equal(score.artifacts, 2);
  assert.equal(score.artifactPoints, 4); // 3 + 1
});

test("endgame BASE: both robots full gives 10 + 10 + 10 bonus", () => {
  const entry = { ...emptyManualEntry(), baseRobot1: "full" as const, baseRobot2: "full" as const };
  const score = computeAllianceScore("red", [], entry);
  assert.equal(score.endgamePoints, 30);
});

test("endgame BASE: one partial one full = 15, no bonus", () => {
  const entry = { ...emptyManualEntry(), baseRobot1: "partial" as const, baseRobot2: "full" as const };
  const score = computeAllianceScore("red", [], entry);
  assert.equal(score.endgamePoints, 15);
});

test("leave and pattern points apply per the manual", () => {
  const entry = { ...emptyManualEntry(), robotsLeft: 2, patternArtifacts: 3 };
  const score = computeAllianceScore("red", [], entry);
  assert.equal(score.leavePoints, 6); // 2 * 3
  assert.equal(score.patternPoints, 6); // 3 * 2
});

test("total sums artifacts + pattern + leave + endgame + adjustment", () => {
  const entry = {
    ...emptyManualEntry(),
    robotsLeft: 1, // +3
    patternArtifacts: 2, // +4
    baseRobot1: "full" as const, // +10
    manualAdjustment: -2,
  };
  const events = [ev({}), ev({})]; // +6
  const score = computeAllianceScore("red", events, entry);
  assert.equal(score.total, 6 + 4 + 3 + 10 - 2);
});
