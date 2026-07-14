// Deterministic statistics engine for Single Team Analysis (Phase 2).
//
// Every number here is computed straight from the normalized match list — no AI.
// Formulas for the derived 0–100 scores (consistency, improvement, role ratings)
// are documented inline so they are auditable, per spec §8. All ratings are
// ALLIANCE-LEVEL and are explicitly inferred, never a claim about the team's
// isolated robot contribution.

import type { NormalizedMatch } from "@/lib/teamAnalysis/matches";

export interface PerformanceStats {
  totalMatches: number;
  qualMatches: number;
  playoffMatches: number;
  wins: number;
  losses: number;
  ties: number;
  winRatePct: number | null;
  playoffWinRatePct: number | null;
  avgScore: number;
  medianScore: number;
  maxScore: number;
  minScore: number;
  avgOpponentScore: number;
  avgMargin: number;
  medianMargin: number;
  scoreStdDev: number;
  marginStdDev: number;
  avgAuto: number;
  avgTeleop: number;
  avgBase: number;
  avgPenaltiesCommitted: number;
  penaltyStdDev: number;
  consistencyScore: number; // 0–100
  improvementScore: number | null; // 0–100, null when too few matches
  improvementNote: string;
}

export interface RoleScores {
  autonomous: number;
  teleop: number;
  endgame: number;
  consistency: number;
  penaltySafety: number;
  allianceValue: number;
  playoffReadiness: number;
  upside: number;
  risk: number;
}

export interface OutlierMatch {
  match: NormalizedMatch;
  reason: string;
  z: number;
}

export interface Percentiles {
  overall: number | null;
  auto: number | null;
  teleop: number | null;
  endgame: number | null;
}

// ---- math helpers -----------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// ---- performance stats ------------------------------------------------------

export function computeStats(matches: NormalizedMatch[]): PerformanceStats {
  // Surrogate matches don't count toward a team's record or rate stats.
  const counted = matches.filter((m) => !m.surrogate);
  const quals = counted.filter((m) => m.level === "qual");
  const playoffs = counted.filter((m) => m.level === "playoff");

  const scores = counted.map((m) => m.allianceScore);
  const oppScores = counted.map((m) => m.opponentScore);
  const margins = counted.map((m) => m.margin);
  const penalties = counted.map((m) => m.penaltiesCommitted);

  const wins = counted.filter((m) => m.result === "W").length;
  const losses = counted.filter((m) => m.result === "L").length;
  const ties = counted.filter((m) => m.result === "T").length;
  const decided = wins + losses + ties;

  const playoffWins = playoffs.filter((m) => m.result === "W").length;

  const avgScore = mean(scores);
  const scoreStdDev = stdDev(scores);

  // Consistency (0–100): WITHIN-event score steadiness, so a team that climbs all
  // season isn't mislabeled "inconsistent" for its season-long growth. Averages
  // each event's coefficient of variation (weighted by matches); falls back to the
  // global CV when no event has enough matches to measure on its own.
  const byEvent = new Map<string, number[]>();
  for (const mm of counted) {
    const arr = byEvent.get(mm.eventCode) ?? [];
    arr.push(mm.allianceScore);
    byEvent.set(mm.eventCode, arr);
  }
  let cvWeighted = 0;
  let cvWeight = 0;
  for (const arr of byEvent.values()) {
    if (arr.length < 3) continue;
    const mu = mean(arr);
    if (mu > 0) {
      cvWeighted += (stdDev(arr) / mu) * arr.length;
      cvWeight += arr.length;
    }
  }
  const withinCv = cvWeight > 0 ? cvWeighted / cvWeight : avgScore > 0 ? scoreStdDev / avgScore : 1;
  const consistencyScore = Math.round(clamp(100 - withinCv * 175));

  // Improvement (0–100, 50 = flat): compares the mean score of the earliest third
  // of matches to the latest third, chronologically. Needs ≥6 matches so normal
  // noise isn't labeled as a trend.
  let improvementScore: number | null = null;
  let improvementNote: string;
  if (counted.length < 6) {
    improvementNote = `Needs at least 6 matches to judge a trend (has ${counted.length}).`;
  } else {
    const third = Math.max(1, Math.floor(counted.length / 3));
    const early = mean(scores.slice(0, third));
    const late = mean(scores.slice(-third));
    const rel = early > 0 ? (late - early) / early : 0;
    improvementScore = Math.round(clamp(50 + rel * 120));
    improvementNote = `Early-season avg ${round1(early)} → late-season avg ${round1(late)} (first vs last ${third} matches).`;
  }

  return {
    totalMatches: counted.length,
    qualMatches: quals.length,
    playoffMatches: playoffs.length,
    wins,
    losses,
    ties,
    winRatePct: decided > 0 ? Math.round((wins / decided) * 100) : null,
    playoffWinRatePct: playoffs.length > 0 ? Math.round((playoffWins / playoffs.length) * 100) : null,
    avgScore: round1(avgScore),
    medianScore: round1(median(scores)),
    maxScore: scores.length ? Math.max(...scores) : 0,
    minScore: scores.length ? Math.min(...scores) : 0,
    avgOpponentScore: round1(mean(oppScores)),
    avgMargin: round1(mean(margins)),
    medianMargin: round1(median(margins)),
    scoreStdDev: round1(scoreStdDev),
    marginStdDev: round1(stdDev(margins)),
    avgAuto: round1(mean(counted.map((m) => m.auto))),
    avgTeleop: round1(mean(counted.map((m) => m.teleop))),
    avgBase: round1(mean(counted.map((m) => m.base))),
    avgPenaltiesCommitted: round1(mean(penalties)),
    penaltyStdDev: round1(stdDev(penalties)),
    consistencyScore,
    improvementScore,
    improvementNote,
  };
}

// ---- inferred role ratings --------------------------------------------------

// Prefer the national OPR percentile for the scoring phases (the most defensible
// signal); everything else is a documented blend of the deterministic stats.
export function computeRoleScores(stats: PerformanceStats, pct: Percentiles): RoleScores {
  const autonomous = Math.round(pct.auto ?? clamp(stats.avgAuto * 1.1));
  const teleop = Math.round(pct.teleop ?? clamp(stats.avgTeleop * 0.5));
  const endgame = Math.round(pct.endgame ?? clamp(stats.avgBase * 3));
  const consistency = stats.consistencyScore;

  // ~45 penalty points/match → 0 safety (DECODE fouls run large; this is alliance-level).
  const penaltySafety = Math.round(clamp(100 - stats.avgPenaltiesCommitted * 2.2));
  const overall = pct.overall ?? 50;
  const allianceValue = Math.round(clamp(0.55 * overall + 0.45 * consistency));
  const playoffReadiness = Math.round(
    stats.playoffWinRatePct !== null
      ? clamp(0.6 * stats.playoffWinRatePct + 0.4 * consistency)
      : clamp(0.5 * overall + 0.5 * consistency),
  );
  // Ceiling above the team's own typical output.
  const upside = Math.round(
    clamp(50 + (stats.avgScore > 0 ? ((stats.maxScore - stats.avgScore) / stats.avgScore) * 100 : 0)),
  );
  const risk = Math.round(clamp(0.6 * (100 - consistency) + 0.4 * (100 - penaltySafety)));

  return { autonomous, teleop, endgame, consistency, penaltySafety, allianceValue, playoffReadiness, upside, risk };
}

// ---- outlier detection: best & concerning matches ---------------------------

export function selectNotableMatches(matches: NormalizedMatch[]): {
  best: OutlierMatch[];
  concerning: OutlierMatch[];
} {
  const counted = matches.filter((m) => !m.surrogate);
  if (counted.length < 3) return { best: [], concerning: [] };

  const scores = counted.map((m) => m.allianceScore);
  const m = mean(scores);
  const sd = stdDev(scores);
  const z = (v: number) => (sd > 0 ? (v - m) / sd : 0);

  // Best: reward genuine peaks — score z-score, margin, and playoff weight —
  // rather than raw score, so a big win over a real opponent beats a blowout.
  const best = [...counted]
    .map((match) => {
      const score = z(match.allianceScore) + Math.min(1.5, match.margin / 60) + (match.level === "playoff" ? 0.3 : 0);
      const rps = [match.rp.movement, match.rp.goal, match.rp.pattern].filter(Boolean).length;
      const reason =
        `${match.allianceScore} pts` +
        (match.result === "W" ? `, won by ${match.margin}` : match.result === "T" ? ", tied" : `, lost by ${-match.margin}`) +
        (match.level === "playoff" ? ` in ${match.levelLabel.toLowerCase()}` : "") +
        (rps ? `, ${rps} RP objective${rps > 1 ? "s" : ""}` : "");
      return { match, reason, z: round1(z(match.allianceScore)), _score: score };
    })
    .filter((o) => o._score > 0.2)
    .sort((a, b) => b._score - a._score)
    .slice(0, 5)
    .map(({ match, reason, z }) => ({ match, reason, z }));

  // Concerning: losses and unusually low outputs. Neutral, non-blaming language.
  const concerning = [...counted]
    .map((match) => {
      const severity = -z(match.allianceScore) + (match.result === "L" ? 0.8 : 0) + (match.noShow ? 3 : 0);
      const reason = match.noShow
        ? "No-show / did not compete"
        : match.result === "L"
          ? `Lost by ${-match.margin} (${match.allianceScore}–${match.opponentScore})`
          : `Below-typical output: ${match.allianceScore} pts`;
      return { match, reason, z: round1(z(match.allianceScore)), _sev: severity };
    })
    .filter((o) => o._sev > 0.3)
    .sort((a, b) => b._sev - a._sev)
    .slice(0, 5)
    .map(({ match, reason, z }) => ({ match, reason, z }));

  return { best, concerning };
}
