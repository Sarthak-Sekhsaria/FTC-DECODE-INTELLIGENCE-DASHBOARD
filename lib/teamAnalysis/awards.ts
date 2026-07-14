// DECODE-season awards retrieval for Single Team Analysis (Phase 3).
// Deterministic: pulls the team's official awards from FTCScout and prettifies
// the award type/placement for display. Awards are judged/competition recognition
// and must NOT be treated as proof of match performance.

import { DECODE } from "@/lib/season";

const FTCSCOUT_ENDPOINT = "https://api.ftcscout.org/graphql";

const AWARDS_QUERY = `
  query TeamAwards($number: Int!, $season: Int!) {
    teamByNumber(number: $number) {
      awards(season: $season) {
        type
        placement
        divisionName
        personName
        eventCode
        event { name }
      }
    }
  }
`;

interface RawAward {
  type: string;
  placement: number;
  divisionName: string | null;
  personName: string | null;
  eventCode: string;
  event: { name: string } | null;
}

export interface AwardItem {
  type: string;
  label: string; // prettified type, e.g. "Deans List Finalist"
  placement: number;
  placementLabel: string; // "1st", "2nd", …
  eventCode: string;
  eventName: string;
  personName: string | null;
  divisionName: string | null;
}

function ordinal(n: number): string {
  if (n <= 0) return "—";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function prettify(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

export async function fetchTeamAwards(
  teamNumber: number,
  season: number = DECODE.ftcScoutSeason,
): Promise<AwardItem[]> {
  const res = await fetch(FTCSCOUT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: AWARDS_QUERY, variables: { number: teamNumber, season } }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`FTCScout API request failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`FTCScout API error: ${JSON.stringify(json.errors)}`);

  const raw: RawAward[] = json.data?.teamByNumber?.awards ?? [];
  return raw
    .map((a) => ({
      type: a.type,
      label: prettify(a.type),
      placement: a.placement,
      placementLabel: ordinal(a.placement),
      eventCode: a.eventCode,
      eventName: a.event?.name ?? a.eventCode,
      personName: a.personName,
      divisionName: a.divisionName,
    }))
    .sort((x, y) => x.eventCode.localeCompare(y.eventCode) || x.placement - y.placement);
}
