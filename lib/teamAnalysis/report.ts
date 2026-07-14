// Deterministic report builder for Single Team Analysis.
//
// Shapes VERIFIED FTCScout DECODE-season data into the structured model the report
// UI renders. Everything here is deterministic — no AI, no fabrication.
//   Phase 1: identity, headline stats, event-by-event, season trend, data quality.
//   Phase 2: match-level history + a full statistics engine (performance stats,
//            consistency/improvement, inferred role ratings, best/concerning).
// Narrative/evidence sections (strengths, opponent strategy, …) arrive in Phase 3.

import { fetchTeamResearch, type EventResult, type TeamResearch } from "@/lib/ftcscout";
import { fetchTeamMatches, type NormalizedMatch } from "@/lib/teamAnalysis/matches";
import { fetchTeamAwards, type AwardItem } from "@/lib/teamAnalysis/awards";
import { TtlCache } from "@/lib/teamAnalysis/cache";
import {
  computeRoleScores,
  computeStats,
  selectNotableMatches,
  type OutlierMatch,
  type PerformanceStats,
  type RoleScores,
} from "@/lib/teamAnalysis/stats";
import { DECODE } from "@/lib/season";

export type ConfidenceLevel = "very-high" | "high" | "medium" | "low" | "very-low";

export interface Confidence {
  level: ConfidenceLevel;
  score: number; // 0–100
  label: string;
}

export type Grade = "S" | "A" | "B" | "C" | "D" | "?";

export interface StatCard {
  label: string;
  value: string;
  sub?: string;
}

export interface PercentileBar {
  label: string;
  value: number | null; // national percentile 0–100
}

export interface TrendPoint {
  event: string;
  opr: number;
}

export interface TeamAnalysisReport {
  ok: true;
  season: { name: string; years: string };
  generatedAt: string;
  team: {
    number: number;
    name: string;
    organization: string;
    location: string;
    rookieYear: number | null;
  };
  grade: Grade;
  gradeLabel: string;
  overallConfidence: Confidence;
  headline: StatCard[];
  percentiles: PercentileBar[];
  record: { wins: number; losses: number; ties: number; winRatePct: number | null };
  snapshot: string[];
  snapshotConfidence: Confidence;
  events: EventResult[];
  eventsConfidence: Confidence;
  trend: {
    direction: TeamResearch["trend"];
    headline: string;
    note: string;
    points: TrendPoint[];
    confidence: Confidence;
  };
  // ---- Phase 2 ----
  hasMatchData: boolean;
  matches: NormalizedMatch[];
  matchesConfidence: Confidence;
  stats: PerformanceStats | null;
  statsConfidence: Confidence;
  roleScores: RoleScores | null;
  rolesConfidence: Confidence;
  bestMatches: OutlierMatch[];
  concerningMatches: OutlierMatch[];
  notableConfidence: Confidence;
  awards: AwardItem[];
  awardsConfidence: Confidence;
  // ----
  dataQuality: {
    sourcesUsed: string[];
    eventsFound: number;
    matchesFound: number;
    limitations: string[];
    missing: string[];
    explanation: string;
    confidence: Confidence;
  };
}

export type AnalysisErrorCode = "INVALID_TEAM" | "TEAM_NOT_FOUND" | "NO_DECODE_DATA" | "UPSTREAM_ERROR";

export interface TeamAnalysisError {
  ok: false;
  code: AnalysisErrorCode;
  message: string;
}

export type TeamAnalysisResult = TeamAnalysisReport | TeamAnalysisError;

function confidence(score: number): Confidence {
  const s = Math.round(Math.max(0, Math.min(100, score)));
  if (s >= 90) return { level: "very-high", score: s, label: "Very high confidence" };
  if (s >= 75) return { level: "high", score: s, label: "High confidence" };
  if (s >= 55) return { level: "medium", score: s, label: "Medium confidence" };
  if (s >= 35) return { level: "low", score: s, label: "Low confidence" };
  return { level: "very-low", score: s, label: "Very low confidence" };
}

// Map an AI-declared confidence level (from the narrative) to a Confidence badge.
export function levelToConfidence(level: ConfidenceLevel): Confidence {
  const mid: Record<ConfidenceLevel, number> = { "very-high": 95, high: 80, medium: 65, low: 45, "very-low": 20 };
  return confidence(mid[level]);
}

// Performance tier from the team's national overall-OPR percentile.
function gradeFor(overall: number | null): { grade: Grade; label: string } {
  if (overall === null) return { grade: "?", label: "Insufficient ranking data" };
  if (overall >= 97) return { grade: "S", label: "World-class" };
  if (overall >= 88) return { grade: "A", label: "Elite" };
  if (overall >= 70) return { grade: "B", label: "Strong" };
  if (overall >= 45) return { grade: "C", label: "Competitive" };
  if (overall >= 20) return { grade: "D", label: "Developing" };
  return { grade: "?", label: "Emerging" };
}

export async function buildTeamAnalysis(teamNumber: number): Promise<TeamAnalysisResult> {
  // Identity/stats and match history in parallel. A match-fetch failure degrades
  // gracefully to the Phase-1 (event-level) report rather than failing outright.
  const [research, matches, awards] = await Promise.all([
    fetchTeamResearch(teamNumber, DECODE.ftcScoutSeason),
    fetchTeamMatches(teamNumber, DECODE.ftcScoutSeason).catch(() => [] as NormalizedMatch[]),
    fetchTeamAwards(teamNumber, DECODE.ftcScoutSeason).catch(() => [] as AwardItem[]),
  ]);

  if (!research.found) {
    return {
      ok: false,
      code: "TEAM_NOT_FOUND",
      message: `Team ${teamNumber} could not be found in FTCScout. Double-check the number and try again.`,
    };
  }

  if (research.eventsPlayed === 0 || research.events.length === 0) {
    return {
      ok: false,
      code: "NO_DECODE_DATA",
      message: `Team ${teamNumber} (${research.name}) was found, but has no recorded FTC DECODE ${DECODE.years} match data yet.`,
    };
  }

  const overall = research.percentiles.overall;
  const { grade, label: gradeLabel } = gradeFor(overall);

  // Phase 2 computations (guarded — may be empty for teams without match records).
  const hasMatchData = matches.length > 0;
  const stats = hasMatchData ? computeStats(matches) : null;
  const roleScores = stats ? computeRoleScores(stats, research.percentiles) : null;
  const { best: bestMatches, concerning: concerningMatches } = hasMatchData
    ? selectNotableMatches(matches)
    : { best: [], concerning: [] };

  // Prefer match-derived record/counts (includes playoffs) when available, else
  // fall back to the event-stats qualification record from Phase 1.
  const useStats = stats !== null && stats.totalMatches > 0;
  const wins = useStats ? stats!.wins : research.totalWins;
  const losses = useStats ? stats!.losses : research.totalLosses;
  const ties = useStats ? stats!.ties : research.totalTies;
  const matchCount = useStats ? stats!.totalMatches : wins + losses + ties;
  const winRatePct = useStats
    ? stats!.winRatePct
    : matchCount > 0
      ? Math.round((wins / matchCount) * 100)
      : null;

  // Overall confidence — transparent function of sample size and ranking availability.
  let confScore = 20;
  confScore += Math.min(research.eventsPlayed, 4) * 10; // up to +40 for events
  confScore += Math.min(matchCount, 40) * 0.9; // up to +36 for match volume
  if (overall !== null) confScore += 8; // ranking available
  const overallConfidence = confidence(confScore);

  const opr = research.nationalOpr;
  const headline: StatCard[] = [
    {
      label: "Season OPR",
      value: opr ? opr.value.toFixed(1) : "—",
      sub: opr ? `#${opr.rank.toLocaleString()} of ${opr.outOf.toLocaleString()}` : "unranked",
    },
    {
      label: "Record (W–L–T)",
      value: `${wins}–${losses}–${ties}`,
      sub: useStats ? "quals + playoffs" : "qualification",
    },
    { label: "Win Rate", value: winRatePct === null ? "—" : `${winRatePct}%` },
    {
      label: "Matches",
      value: `${matchCount}`,
      sub: useStats ? `${stats!.qualMatches} qual · ${stats!.playoffMatches} playoff` : "qualification",
    },
    { label: "Events", value: `${research.eventsPlayed}`, sub: DECODE.name },
  ];

  const percentiles: PercentileBar[] = [
    { label: "Overall", value: research.percentiles.overall },
    { label: "Autonomous", value: research.percentiles.auto },
    { label: "TeleOp", value: research.percentiles.teleop },
    { label: "Endgame", value: research.percentiles.endgame },
  ];

  // Deterministic snapshot bullets (pure facts from the data).
  const snapshot: string[] = [];
  snapshot.push(
    `Played ${research.eventsPlayed} DECODE event${research.eventsPlayed === 1 ? "" : "s"} and ${matchCount} matches with a ${wins}–${losses}–${ties} record${winRatePct !== null ? ` (${winRatePct}% wins)` : ""}.`,
  );
  if (opr) {
    snapshot.push(
      `Season OPR of ${opr.value.toFixed(1)} ranks #${opr.rank.toLocaleString()} of ${opr.outOf.toLocaleString()} DECODE teams — ${gradeLabel.toLowerCase()}.`,
    );
  }
  const rankedPhases = (
    [
      { name: "autonomous", v: research.percentiles.auto },
      { name: "teleop", v: research.percentiles.teleop },
      { name: "endgame", v: research.percentiles.endgame },
    ] as { name: string; v: number | null }[]
  ).filter((p): p is { name: string; v: number } => p.v !== null);
  if (rankedPhases.length > 0) {
    const top = rankedPhases.reduce((a, b) => (b.v > a.v ? b : a));
    snapshot.push(`Relative strength is ${top.name} (national ${top.v}th percentile).`);
  }
  if (stats) {
    snapshot.push(
      `Alliance scoring averages ${stats.avgScore} pts (consistency ${stats.consistencyScore}/100)${stats.playoffWinRatePct !== null ? `, playoff win rate ${stats.playoffWinRatePct}%` : ""}.`,
    );
  }
  snapshot.push(
    research.trend === "improving"
      ? "Scoring trended upward across the season."
      : research.trend === "declining"
        ? "Scoring trended downward across the season."
        : research.trend === "steady"
          ? "Scoring stayed roughly steady across the season."
          : "Not enough events to establish a season-long trend.",
  );

  // Season trend (reuses the FTCScout client's early-vs-late OPR comparison).
  const points: TrendPoint[] = research.events.map((e) => ({ event: e.name, opr: e.oprTotal }));
  const trendHeadline =
    research.trend === "improving"
      ? "Moderate upward trend"
      : research.trend === "declining"
        ? "Moderate decline"
        : research.trend === "steady"
          ? "Stable"
          : "Insufficient evidence";
  const trendNote =
    research.eventsPlayed >= 2
      ? "Compares average event OPR between the team's earlier and later DECODE events."
      : "A season trend needs at least two DECODE events; only one is on record so far.";
  const trendConfidence = confidence(research.eventsPlayed >= 3 ? 74 : research.eventsPlayed === 2 ? 58 : 38);

  // Data quality — honest about what is and isn't covered.
  const limitations: string[] = [
    "All FTCScout scores are alliance-level — an individual robot's exact contribution cannot be isolated.",
    "OPR and every 0–100 role rating are modeled estimates, not direct measurements.",
  ];
  if (matchCount < 12) {
    limitations.push(`Small sample size (${matchCount} matches) — treat rate statistics cautiously.`);
  }
  limitations.push("Narrative strengths/weaknesses, alliance value, and opponent strategy arrive in a later phase.");

  const missing: string[] = [];
  if (overall === null) missing.push("National OPR ranking / percentiles");
  if (!hasMatchData) missing.push("Per-match score breakdowns");
  missing.push("Awards & recognition", "Match video links");

  const matchesFound = useStats ? stats!.totalMatches : wins + losses + ties;

  return {
    ok: true,
    season: { name: DECODE.name, years: DECODE.years },
    generatedAt: new Date().toISOString(),
    team: {
      number: research.number,
      name: research.name,
      organization: research.schoolName,
      location: research.location,
      rookieYear: research.rookieYear || null,
    },
    grade,
    gradeLabel,
    overallConfidence,
    headline,
    percentiles,
    record: { wins, losses, ties, winRatePct },
    snapshot,
    snapshotConfidence: confidence(overall !== null ? 86 : 68),
    events: research.events,
    eventsConfidence: confidence(research.eventsPlayed >= 2 ? 85 : 68),
    trend: {
      direction: research.trend,
      headline: trendHeadline,
      note: trendNote,
      points,
      confidence: trendConfidence,
    },
    hasMatchData,
    matches,
    matchesConfidence: confidence(hasMatchData ? 90 : 30),
    stats,
    statsConfidence: confidence(!useStats ? 30 : matchCount >= 24 ? 82 : matchCount >= 12 ? 66 : 48),
    roleScores,
    // Role ratings are inferred from alliance-level data — capped at medium.
    rolesConfidence: confidence(roleScores ? (matchCount >= 24 ? 68 : 56) : 30),
    bestMatches,
    concerningMatches,
    notableConfidence: confidence(hasMatchData ? (matchCount >= 12 ? 70 : 52) : 30),
    awards,
    awardsConfidence: confidence(90),
    dataQuality: {
      sourcesUsed: ["FTCScout (api.ftcscout.org) — aggregates official FTC Events results"],
      eventsFound: research.eventsPlayed,
      matchesFound,
      limitations,
      missing,
      explanation: `Confidence reflects ${research.eventsPlayed} event${research.eventsPlayed === 1 ? "" : "s"} and ${matchesFound} matches of verified DECODE data${overall !== null ? ", with a national OPR ranking available" : ", with no national ranking yet"}.`,
      confidence: confidence(hasMatchData ? 92 : 82),
    },
  };
}

// ---- caching ----------------------------------------------------------------

// FTCScout data changes slowly (only after events), so a short TTL keeps repeat
// views instant without serving stale results. Only successful reports are cached.
const reportCache = new TtlCache<TeamAnalysisReport>(15 * 60 * 1000);

export async function getTeamAnalysis(
  teamNumber: number,
  refresh = false,
): Promise<{ result: TeamAnalysisResult; fromCache: boolean }> {
  const key = String(teamNumber);
  if (!refresh) {
    const hit = reportCache.get(key);
    if (hit) return { result: hit.value, fromCache: true };
  }
  const result = await buildTeamAnalysis(teamNumber);
  if (result.ok) reportCache.set(key, result);
  return { result, fromCache: false };
}
