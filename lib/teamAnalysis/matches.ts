// Match-level retrieval + normalization for Single Team Analysis (Phase 2).
//
// Pulls every DECODE-season match a team played from FTCScout and flattens each
// one — from the selected team's point of view — into a NormalizedMatch: our
// score vs the opponent, the auto/teleop/base breakdown, penalties, ranking-point
// flags, partners, and opponents. All deterministic; no AI, no fabrication.

import { DECODE } from "@/lib/season";

const FTCSCOUT_ENDPOINT = "https://api.ftcscout.org/graphql";

// One reusable selection of the 2025 alliance score breakdown.
const ALLIANCE_FIELDS = `
  autoPoints dcPoints dcBasePoints autoArtifactPoints dcArtifactPoints
  penaltyPointsCommitted penaltyPointsByOpp totalPoints totalPointsNp
  movementRp goalRp patternRp
`;

const MATCHES_QUERY = `
  query TeamMatches($number: Int!, $season: Int!) {
    teamByNumber(number: $number) {
      matches(season: $season) {
        eventCode
        alliance
        surrogate
        noShow
        dq
        match {
          id
          tournamentLevel
          series
          matchNum
          hasBeenPlayed
          actualStartTime
          scheduledStartTime
          event { name }
          scores {
            __typename
            ... on MatchScores2025 {
              red { ${ALLIANCE_FIELDS} }
              blue { ${ALLIANCE_FIELDS} }
            }
          }
          teams { teamNumber alliance }
        }
      }
    }
  }
`;

type AllianceColor = "Red" | "Blue" | "Solo";

interface RawAllianceScore {
  autoPoints: number;
  dcPoints: number;
  dcBasePoints: number;
  autoArtifactPoints: number;
  dcArtifactPoints: number;
  penaltyPointsCommitted: number;
  penaltyPointsByOpp: number;
  totalPoints: number;
  totalPointsNp: number;
  movementRp: boolean;
  goalRp: boolean;
  patternRp: boolean;
}

interface RawMatchParticipation {
  eventCode: string;
  alliance: AllianceColor;
  surrogate: boolean;
  noShow: boolean;
  dq: boolean;
  match: {
    id: number;
    tournamentLevel: "Quals" | "Semis" | "Finals" | "DoubleElim";
    series: number;
    matchNum: number;
    hasBeenPlayed: boolean;
    actualStartTime: string | null;
    scheduledStartTime: string | null;
    event: { name: string };
    scores:
      | { __typename: "MatchScores2025"; red: RawAllianceScore; blue: RawAllianceScore }
      | { __typename: string }
      | null;
    teams: { teamNumber: number; alliance: AllianceColor }[];
  };
}

export type MatchLevel = "qual" | "playoff";
export type MatchResult = "W" | "L" | "T";

export interface NormalizedMatch {
  eventCode: string;
  eventName: string;
  level: MatchLevel;
  levelLabel: string; // "Quals" | "Semis" | "Finals" | "DoubleElim"
  matchNum: number;
  series: number;
  time: string | null; // ISO, best available
  alliance: "Red" | "Blue";
  partners: number[];
  opponents: number[];
  allianceScore: number;
  opponentScore: number;
  result: MatchResult;
  margin: number;
  auto: number;
  teleop: number;
  base: number; // endgame/BASE points
  penaltiesCommitted: number; // penalty points this alliance gave away
  rp: { movement: boolean; goal: boolean; pattern: boolean };
  surrogate: boolean;
  noShow: boolean;
  dq: boolean;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(FTCSCOUT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`FTCScout API request failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`FTCScout API error: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

export async function fetchTeamMatches(
  teamNumber: number,
  season: number = DECODE.ftcScoutSeason,
): Promise<NormalizedMatch[]> {
  const data = await graphql<{ teamByNumber: { matches: RawMatchParticipation[] } | null }>(
    MATCHES_QUERY,
    { number: teamNumber, season },
  );

  const raw = data.teamByNumber?.matches ?? [];
  const out: NormalizedMatch[] = [];

  for (const p of raw) {
    const m = p.match;
    if (!m.hasBeenPlayed) continue;
    if (!m.scores || m.scores.__typename !== "MatchScores2025") continue;
    if (p.alliance !== "Red" && p.alliance !== "Blue") continue; // DECODE has no Solo

    const scores = m.scores as { red: RawAllianceScore; blue: RawAllianceScore };
    const ours = p.alliance === "Red" ? scores.red : scores.blue;
    const theirs = p.alliance === "Red" ? scores.blue : scores.red;

    const partners = m.teams
      .filter((t) => t.alliance === p.alliance && t.teamNumber !== teamNumber)
      .map((t) => t.teamNumber);
    const opponents = m.teams
      .filter((t) => t.alliance !== p.alliance && (t.alliance === "Red" || t.alliance === "Blue"))
      .map((t) => t.teamNumber);

    const margin = ours.totalPoints - theirs.totalPoints;
    const result: MatchResult = margin > 0 ? "W" : margin < 0 ? "L" : "T";

    out.push({
      eventCode: p.eventCode,
      eventName: m.event?.name ?? p.eventCode,
      level: m.tournamentLevel === "Quals" ? "qual" : "playoff",
      levelLabel: m.tournamentLevel,
      matchNum: m.matchNum,
      series: m.series,
      time: m.actualStartTime ?? m.scheduledStartTime ?? null,
      alliance: p.alliance,
      partners,
      opponents,
      allianceScore: ours.totalPoints,
      opponentScore: theirs.totalPoints,
      result,
      margin,
      auto: ours.autoPoints,
      teleop: ours.dcPoints,
      base: ours.dcBasePoints,
      penaltiesCommitted: ours.penaltyPointsCommitted,
      rp: { movement: ours.movementRp, goal: ours.goalRp, pattern: ours.patternRp },
      surrogate: p.surrogate,
      noShow: p.noShow,
      dq: p.dq,
    });
  }

  // Chronological order (best available timestamp), matches without a time last,
  // ties broken by event then match number.
  out.sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.eventCode.localeCompare(b.eventCode) || a.matchNum - b.matchNum;
  });

  return out;
}
