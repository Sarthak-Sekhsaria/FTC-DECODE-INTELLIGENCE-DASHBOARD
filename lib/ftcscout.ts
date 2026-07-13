// Research data client for the FTCScout public API (https://ftcscout.org).
// FTCScout aggregates official FTC Events data (matches, rankings, OPR) with no API key required.

const FTCSCOUT_ENDPOINT = "https://api.ftcscout.org/graphql";

// FTCScout seasons are keyed by the starting year of the school year, so the
// 2025-2026 DECODE season is season 2025.
export const DECODE_SEASON = 2025;

const TEAM_RESEARCH_QUERY = `
  query TeamResearch($number: Int!, $season: Int!) {
    teamByNumber(number: $number) {
      number
      name
      schoolName
      location { city state country }
      rookieYear
      quickStats(season: $season) {
        tot { value rank }
        auto { value rank }
        dc { value rank }
        eg { value rank }
        count
      }
      events(season: $season) {
        eventCode
        event { name start remote type }
        stats {
          __typename
          ... on TeamEventStats2025 {
            rank
            rp
            wins
            losses
            ties
            dqs
            qualMatchesPlayed
            avg { totalPoints autoPoints dcPoints penaltyPointsCommitted penaltyPointsByOpp }
            opr { totalPoints autoPoints dcPoints }
            dev { totalPoints }
            max { totalPoints }
          }
        }
      }
    }
  }
`;

interface QuickStat {
  value: number;
  rank: number;
}

interface RawEventStats {
  __typename: string;
  rank: number;
  rp: number;
  wins: number;
  losses: number;
  ties: number;
  dqs: number;
  qualMatchesPlayed: number;
  avg: {
    totalPoints: number;
    autoPoints: number;
    dcPoints: number;
    penaltyPointsCommitted: number;
    penaltyPointsByOpp: number;
  };
  opr: { totalPoints: number; autoPoints: number; dcPoints: number };
  dev: { totalPoints: number };
  max: { totalPoints: number };
}

interface RawEvent {
  eventCode: string;
  event: { name: string; start: string; remote: boolean; type: string };
  stats: RawEventStats | null;
}

interface RawTeam {
  number: number;
  name: string;
  schoolName: string;
  location: { city: string; state: string | null; country: string };
  rookieYear: number;
  quickStats: {
    tot: QuickStat;
    auto: QuickStat;
    dc: QuickStat;
    eg: QuickStat;
    count: number;
  } | null;
  events: RawEvent[];
}

export interface EventResult {
  name: string;
  code: string;
  start: string;
  type: string;
  rank: number;
  record: string;
  rankingPoints: number;
  avgTotalPoints: number;
  avgAutoPoints: number;
  avgDcPoints: number;
  avgPenaltyCommitted: number;
  avgPenaltyByOpp: number;
  oprTotal: number;
  maxScore: number;
  consistency: number; // coefficient of variation of match score (lower = more consistent)
}

export interface TeamResearch {
  found: true;
  number: number;
  name: string;
  schoolName: string;
  location: string;
  rookieYear: number;
  percentiles: {
    overall: number | null;
    auto: number | null;
    teleop: number | null;
    endgame: number | null;
  };
  totalWins: number;
  totalLosses: number;
  totalTies: number;
  eventsPlayed: number;
  events: EventResult[];
  trend: "improving" | "declining" | "steady" | "unknown";
}

export interface TeamNotFound {
  found: false;
  number: number;
}

export type TeamResearchResult = TeamResearch | TeamNotFound;

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(FTCSCOUT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`FTCScout API request failed: ${res.status}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`FTCScout API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

function percentile(stat: QuickStat | undefined, count: number | undefined): number | null {
  if (!stat || !count || count <= 1) return null;
  return Math.round((1 - (stat.rank - 1) / (count - 1)) * 1000) / 10;
}

export async function fetchTeamResearch(
  teamNumber: number,
  season: number = DECODE_SEASON,
): Promise<TeamResearchResult> {
  const data = await graphql<{ teamByNumber: RawTeam | null }>(TEAM_RESEARCH_QUERY, {
    number: teamNumber,
    season,
  });

  const team = data.teamByNumber;
  if (!team) {
    return { found: false, number: teamNumber };
  }

  const playedEvents = team.events
    .filter((e): e is RawEvent & { stats: RawEventStats } => e.stats !== null)
    .sort((a, b) => a.event.start.localeCompare(b.event.start));

  const events: EventResult[] = playedEvents.map((e) => ({
    name: e.event.name,
    code: e.eventCode,
    start: e.event.start,
    type: e.event.type,
    rank: e.stats.rank,
    record: `${e.stats.wins}-${e.stats.losses}-${e.stats.ties}`,
    rankingPoints: round1(e.stats.rp),
    avgTotalPoints: round1(e.stats.avg.totalPoints),
    avgAutoPoints: round1(e.stats.avg.autoPoints),
    avgDcPoints: round1(e.stats.avg.dcPoints),
    avgPenaltyCommitted: round1(e.stats.avg.penaltyPointsCommitted),
    avgPenaltyByOpp: round1(e.stats.avg.penaltyPointsByOpp),
    oprTotal: round1(e.stats.opr.totalPoints),
    maxScore: round1(e.stats.max.totalPoints),
    consistency:
      e.stats.avg.totalPoints > 0
        ? Math.round((e.stats.dev.totalPoints / e.stats.avg.totalPoints) * 100) / 100
        : 0,
  }));

  const totalWins = playedEvents.reduce((sum, e) => sum + e.stats.wins, 0);
  const totalLosses = playedEvents.reduce((sum, e) => sum + e.stats.losses, 0);
  const totalTies = playedEvents.reduce((sum, e) => sum + e.stats.ties, 0);

  let trend: TeamResearch["trend"] = "unknown";
  if (events.length >= 2) {
    const half = Math.max(1, Math.floor(events.length / 2));
    const earlyAvg = average(events.slice(0, half).map((e) => e.oprTotal));
    const recentAvg = average(events.slice(-half).map((e) => e.oprTotal));
    const delta = recentAvg - earlyAvg;
    if (Math.abs(delta) < earlyAvg * 0.08) trend = "steady";
    else trend = delta > 0 ? "improving" : "declining";
  }

  return {
    found: true,
    number: team.number,
    name: team.name,
    schoolName: team.schoolName,
    location: [team.location.city, team.location.state, team.location.country]
      .filter(Boolean)
      .join(", "),
    rookieYear: team.rookieYear,
    percentiles: {
      overall: percentile(team.quickStats?.tot, team.quickStats?.count),
      auto: percentile(team.quickStats?.auto, team.quickStats?.count),
      teleop: percentile(team.quickStats?.dc, team.quickStats?.count),
      endgame: percentile(team.quickStats?.eg, team.quickStats?.count),
    },
    totalWins,
    totalLosses,
    totalTies,
    eventsPlayed: playedEvents.length,
    events,
    trend,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function formatTeamResearchForPrompt(research: TeamResearchResult): string {
  if (!research.found) {
    return `Team ${research.number}: NOT FOUND in FTCScout. No DECODE season data is available for this team number. Clearly state that data is missing and estimate cautiously if a prediction must still be made.`;
  }

  const r = research;
  const lines: string[] = [];
  lines.push(`Team ${r.number} — ${r.name}`);
  lines.push(`Location: ${r.location || "unknown"} | Rookie year: ${r.rookieYear}`);

  if (r.eventsPlayed === 0) {
    lines.push(
      "No played DECODE events with recorded stats found for this team yet this season. Data is incomplete — say so clearly and estimate cautiously.",
    );
    return lines.join("\n");
  }

  lines.push(
    `Season record across ${r.eventsPlayed} event(s): ${r.totalWins}-${r.totalLosses}-${r.totalTies} (W-L-T)`,
  );
  lines.push(
    `National OPR percentiles (higher = stronger, out of teams ranked this season): ` +
      `Overall ${fmtPct(r.percentiles.overall)}, Auto ${fmtPct(r.percentiles.auto)}, ` +
      `TeleOp ${fmtPct(r.percentiles.teleop)}, Endgame ${fmtPct(r.percentiles.endgame)}`,
  );
  lines.push(`Performance trend across the season: ${r.trend}`);
  lines.push(`Event-by-event results (chronological, most recent last):`);
  for (const e of r.events) {
    lines.push(
      `  - [${e.start}] ${e.name} (${e.type}): rank ${e.rank}, record ${e.record}, RP ${e.rankingPoints}, ` +
        `avg score ${e.avgTotalPoints} (auto ${e.avgAutoPoints} / teleop ${e.avgDcPoints}), ` +
        `OPR ${e.oprTotal}, max score ${e.maxScore}, avg penalties committed ${e.avgPenaltyCommitted}, ` +
        `avg penalties drawn from opponent ${e.avgPenaltyByOpp}, score consistency (coefficient of variation, lower is steadier) ${e.consistency}`,
    );
  }
  return lines.join("\n");
}

function fmtPct(p: number | null): string {
  return p === null ? "unknown" : `${p}th percentile`;
}
