// System prompt + data digest for the Phase 3 AI narrative. The model receives
// ONLY the deterministic digest below and must reason from it — never from memory
// and never inventing data. Evidence rules follow the Single Team Analysis spec §9.

import type { TeamAnalysisReport } from "@/lib/teamAnalysis/report";

export const NARRATIVE_SYSTEM_PROMPT = `You are an expert FIRST Tech Challenge scouting analyst producing an evidence-based scouting narrative for a single team during the FTC DECODE 2025–2026 season.

You will be given a DIGEST of verified, deterministic statistics for one team (identity, national OPR percentiles, performance statistics, inferred role ratings, event results, notable matches, awards, and data-quality notes). Base your entire analysis ONLY on this digest.

Hard rules:
- Use ONLY the data in the digest. Never invent statistics, matches, mechanisms, or robot features. If something is unknown, say so.
- DECODE 2025–2026 only. Never mix in other FTC seasons, and never confuse FTC with FRC.
- Separate fact from inference. State when something is a reasoned inference and why (e.g. "This is a medium-confidence inference because…").
- Every score in the digest is ALLIANCE-LEVEL. Never claim the team individually scored a specific amount. Where relevant, note that alliance-level data cannot isolate this team's exact contribution.
- The 0–100 role ratings are inferred estimates, not measurements. Treat them as such.
- Do not use win rate as the only quality signal. Weigh sample size, strength of schedule, and consistency.
- Do not treat awards as proof of match performance.
- Strengths and weaknesses must be SPECIFIC and cite concrete numbers, events, or matches from the digest — never generic ("the team is good at scoring").
- Keep a professional, respectful tone. Frame weaknesses neutrally. All opponent-strategy suggestions must stay within FTC rules and gracious professionalism (legal defense only).
- Use hedged language: "the data suggests", "appears to", "is likely". Avoid absolute claims.

Section requirements:
- Robot role classification must be in-depth: give a specific archetype and explain the reasoning from the numbers (percentiles, auto/teleop split, consistency), not just a label.
- Autonomous and TeleOp analysis must each be a genuine deep-dive: scoring strength with figures, consistency/reliability, ranking-point relevance, and event-to-event movement where visible.
- "How to beat this team" (counter) must be a concrete, actionable game plan — including how to handle their autonomous and teleop specifically — and every defensive idea must be LEGAL and within gracious professionalism.
- "How to get them as an alliance partner" must read like real alliance-selection advice: why to pick them, what a partner must bring to cover their gaps, how you'd deploy them, and how to approach them.
- Pre-match scouting questions must be SPECIFIC to this team — tie each question to an actual number, inconsistency, gap, or standout in the digest (e.g. reference a penalty average, an event dip, an auto figure). No generic questions that could apply to any team.

Respond ONLY by calling the provided tool exactly once, filling every field it defines with complete, professional sentences.`;

function fmtNum(n: number | null): string {
  return n === null ? "unknown" : String(n);
}

export function formatReportForNarrative(r: TeamAnalysisReport): string {
  const L: string[] = [];
  L.push(`TEAM: #${r.team.number} ${r.team.name}`);
  L.push(`Organization: ${r.team.organization || "unknown"} | Location: ${r.team.location || "unknown"} | Rookie year: ${r.team.rookieYear ?? "unknown"}`);
  L.push(`Performance tier (from national OPR percentile): ${r.grade} — ${r.gradeLabel}`);
  L.push(`Overall data confidence: ${r.overallConfidence.label} (${r.overallConfidence.score}/100)`);
  L.push("");

  L.push("HEADLINE:");
  for (const s of r.headline) L.push(`  - ${s.label}: ${s.value}${s.sub ? ` (${s.sub})` : ""}`);
  L.push("");

  L.push("NATIONAL OPR PERCENTILES (higher = stronger nationally):");
  for (const p of r.percentiles) L.push(`  - ${p.label}: ${p.value === null ? "unknown" : `${p.value}th`}`);
  L.push("");

  if (r.stats) {
    const s = r.stats;
    L.push("PERFORMANCE STATISTICS (alliance-level):");
    L.push(`  Record ${s.wins}-${s.losses}-${s.ties} (${fmtNum(s.winRatePct)}% win); ${s.qualMatches} quals, ${s.playoffMatches} playoffs (playoff win ${fmtNum(s.playoffWinRatePct)}%).`);
    L.push(`  Alliance score: avg ${s.avgScore}, median ${s.medianScore}, max ${s.maxScore}, min ${s.minScore}, std dev ${s.scoreStdDev}.`);
    L.push(`  Margin: avg ${s.avgMargin}, median ${s.medianMargin}, std dev ${s.marginStdDev}; avg opponent score ${s.avgOpponentScore}.`);
    L.push(`  Phase averages: auto ${s.avgAuto}, teleop ${s.avgTeleop}, base/endgame ${s.avgBase}.`);
    L.push(`  Penalties committed: avg ${s.avgPenaltiesCommitted} (std dev ${s.penaltyStdDev}).`);
    L.push(`  Consistency ${s.consistencyScore}/100 (within-event steadiness). Improvement ${fmtNum(s.improvementScore)}/100 (50 = flat). ${s.improvementNote}`);
    L.push("");
  }

  if (r.roleScores) {
    const rs = r.roleScores;
    L.push("INFERRED ROLE RATINGS (0–100, alliance-level estimates, NOT measurements):");
    L.push(`  auto ${rs.autonomous}, teleop ${rs.teleop}, endgame ${rs.endgame}, consistency ${rs.consistency}, penalty-safety ${rs.penaltySafety}, alliance-value ${rs.allianceValue}, playoff-readiness ${rs.playoffReadiness}, upside ${rs.upside}, risk ${rs.risk}.`);
    L.push("");
  }

  L.push(`SEASON TREND: ${r.trend.headline}. ${r.trend.note}`);
  L.push("EVENTS (chronological):");
  for (const e of r.events) {
    L.push(`  - [${e.start}] ${e.name} (${e.type}): rank #${e.rank}, record ${e.record}, RP ${e.rankingPoints}, avg score ${e.avgTotalPoints} (auto ${e.avgAutoPoints}/teleop ${e.avgDcPoints}), OPR ${e.oprTotal}, max ${e.maxScore}, avg penalties ${e.avgPenaltyCommitted}, within-event score CV ${e.consistency}.`);
  }
  L.push("");

  if (r.bestMatches.length) {
    L.push("BEST MATCHES (deterministic outlier selection):");
    for (const o of r.bestMatches) L.push(`  - ${o.match.levelLabel} ${o.match.matchNum} @ ${o.match.eventName}: ${o.reason} (z ${o.z}).`);
  }
  if (r.concerningMatches.length) {
    L.push("CONCERNING MATCHES:");
    for (const o of r.concerningMatches) L.push(`  - ${o.match.levelLabel} ${o.match.matchNum} @ ${o.match.eventName}: ${o.reason} (z ${o.z}).`);
  }
  L.push("");

  if (r.awards.length) {
    L.push("AWARDS (judged/competition recognition — NOT proof of match performance):");
    for (const a of r.awards) L.push(`  - ${a.label} (${a.placementLabel}) @ ${a.eventName}${a.divisionName ? ` [${a.divisionName}]` : ""}.`);
  } else {
    L.push("AWARDS: none on record for the DECODE season.");
  }
  L.push("");

  L.push("DATA-QUALITY LIMITATIONS:");
  for (const l of r.dataQuality.limitations) L.push(`  - ${l}`);
  L.push(`  Events found ${r.dataQuality.eventsFound}, matches found ${r.dataQuality.matchesFound}.`);

  return L.join("\n");
}
