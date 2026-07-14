// Tests for the Single Team Analysis statistics engine. All deterministic — no
// network, no AI. Covers record/rate math, surrogate exclusion, quals/playoff
// split, within-event consistency, improvement detection, inferred role ratings,
// and best/concerning outlier selection.
//
// Run with:  node --experimental-transform-types --test lib/teamAnalysis/stats.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, computeRoleScores, selectNotableMatches } from "./stats.ts";
import type { NormalizedMatch } from "./matches.ts";

let seq = 0;
function mk(over: Partial<NormalizedMatch> & { allianceScore: number; opponentScore: number }): NormalizedMatch {
  const margin = over.allianceScore - over.opponentScore;
  seq += 1;
  return {
    eventCode: "EV1",
    eventName: "Event One",
    level: "qual",
    levelLabel: "Quals",
    matchNum: seq,
    series: 0,
    time: `2026-01-01T00:${String(seq).padStart(2, "0")}:00Z`,
    alliance: "Red",
    partners: [111],
    opponents: [222, 333],
    result: margin > 0 ? "W" : margin < 0 ? "L" : "T",
    margin,
    auto: 30,
    teleop: 60,
    base: 10,
    penaltiesCommitted: 10,
    rp: { movement: false, goal: false, pattern: false },
    surrogate: false,
    noShow: false,
    dq: false,
    ...over,
  };
}

test("record, win rate, and score/margin averages", () => {
  const matches = [
    mk({ allianceScore: 100, opponentScore: 50 }), // W +50
    mk({ allianceScore: 80, opponentScore: 90 }), // L -10
    mk({ allianceScore: 70, opponentScore: 70 }), // T 0
  ];
  const s = computeStats(matches);
  assert.equal(s.totalMatches, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.ties, 1);
  assert.equal(s.winRatePct, 33); // 1/3
  assert.equal(s.avgScore, 83.3);
  assert.equal(s.maxScore, 100);
  assert.equal(s.minScore, 70);
  assert.equal(s.avgMargin, 13.3); // (50 - 10 + 0)/3
});

test("surrogate matches are excluded from the record", () => {
  const matches = [
    mk({ allianceScore: 100, opponentScore: 50 }),
    mk({ allianceScore: 200, opponentScore: 10, surrogate: true }), // ignored
  ];
  const s = computeStats(matches);
  assert.equal(s.totalMatches, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.maxScore, 100); // surrogate's 200 not counted
});

test("quals/playoffs are split and playoff win rate computed", () => {
  const matches = [
    mk({ allianceScore: 100, opponentScore: 50, level: "qual", levelLabel: "Quals" }),
    mk({ allianceScore: 120, opponentScore: 60, level: "playoff", levelLabel: "Semis" }),
    mk({ allianceScore: 90, opponentScore: 130, level: "playoff", levelLabel: "Finals" }),
  ];
  const s = computeStats(matches);
  assert.equal(s.qualMatches, 1);
  assert.equal(s.playoffMatches, 2);
  assert.equal(s.playoffWinRatePct, 50); // 1 of 2 playoff wins
});

test("improvement: rising scores score >50, flat ~50, and <6 matches is null", () => {
  const rising = [120, 140, 160, 220, 260, 300].map((v) => mk({ allianceScore: v, opponentScore: 50 }));
  const sRise = computeStats(rising);
  assert.ok(sRise.improvementScore !== null && sRise.improvementScore > 55, `expected >55, got ${sRise.improvementScore}`);

  seq = 0;
  const flat = [150, 150, 150, 150, 150, 150].map((v) => mk({ allianceScore: v, opponentScore: 50 }));
  const sFlat = computeStats(flat);
  assert.equal(sFlat.improvementScore, 50);

  seq = 0;
  const few = [100, 110, 120].map((v) => mk({ allianceScore: v, opponentScore: 50 }));
  assert.equal(computeStats(few).improvementScore, null);
});

test("consistency is within-event, so season-long growth stays high", () => {
  // Two events; scores differ a lot BETWEEN events but are identical WITHIN each.
  seq = 0;
  const matches = [
    ...[100, 100, 100].map((v) => mk({ allianceScore: v, opponentScore: 40, eventCode: "A" })),
    ...[400, 400, 400].map((v) => mk({ allianceScore: v, opponentScore: 40, eventCode: "B" })),
  ];
  const s = computeStats(matches);
  assert.equal(s.consistencyScore, 100); // zero within-event variance
});

test("role ratings prefer national percentiles and penalise fouls", () => {
  seq = 0;
  const matches = [120, 140, 160].map((v) => mk({ allianceScore: v, opponentScore: 50, penaltiesCommitted: 0 }));
  const stats = computeStats(matches);
  const roles = computeRoleScores(stats, { overall: 90, auto: 88, teleop: 77, endgame: 66 });
  assert.equal(roles.autonomous, 88); // uses the provided percentile directly
  assert.equal(roles.teleop, 77);
  assert.equal(roles.endgame, 66);
  assert.equal(roles.penaltySafety, 100); // no penalties → full safety

  seq = 0;
  const fouled = [120, 140, 160].map((v) => mk({ allianceScore: v, opponentScore: 50, penaltiesCommitted: 30 }));
  const rolesFouled = computeRoleScores(computeStats(fouled), { overall: 90, auto: 88, teleop: 77, endgame: 66 });
  assert.ok(rolesFouled.penaltySafety < 40, `expected low safety, got ${rolesFouled.penaltySafety}`);
});

test("notable matches: standout win is 'best', a clear loss is 'concerning'", () => {
  seq = 0;
  const matches = [
    mk({ allianceScore: 300, opponentScore: 120 }), // standout win
    mk({ allianceScore: 150, opponentScore: 150 }),
    mk({ allianceScore: 140, opponentScore: 160 }),
    mk({ allianceScore: 80, opponentScore: 200 }), // clear loss
    mk({ allianceScore: 150, opponentScore: 145 }),
  ];
  const { best, concerning } = selectNotableMatches(matches);
  assert.ok(best.length > 0 && best[0].match.allianceScore === 300, "top best should be the 300-pt game");
  assert.ok(
    concerning.some((o) => o.match.allianceScore === 80),
    "the 80–200 loss should be flagged concerning",
  );
});
