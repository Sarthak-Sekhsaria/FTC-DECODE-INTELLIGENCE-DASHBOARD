// Central DECODE season configuration — the single source of truth for season
// identifiers so they are never duplicated across the codebase (Single Team
// Analysis spec §2, "Strict Season Scope").
//
// The platform analyzes ONLY the FTC DECODE 2025–2026 season. Any historical
// data must be clearly labeled and must never influence DECODE conclusions.

export const DECODE = {
  name: "DECODE",
  years: "2025–2026",
  seasonOnly: true,

  // FTCScout keys seasons by the starting calendar year of the school year, so
  // the 2025–2026 DECODE season is season 2025.
  ftcScoutSeason: 2025,
  // Official FIRST API uses the same starting-year convention.
  firstApiSeason: 2025,

  startDate: "2025-09-01",
  endDate: "2026-08-31",

  // Game vocabulary — used for UI labels now and AI grounding in later phases.
  terminology: {
    artifact: "ARTIFACT",
    classified: "CLASSIFIED",
    overflow: "OVERFLOW",
    motif: "MOTIF",
    base: "BASE",
    leave: "LEAVE",
  },
} as const;

export type DecodeSeason = typeof DECODE;
