// Central DECODE scoring configuration — the single source of truth for both the
// Auto Scouting UI and its scoring logic, so values are never scattered across
// files. All values below are taken from the official 2025-2026 FIRST Tech
// Challenge Competition Manual, Section 10 "Game Details" (Table 10-2 point
// values). See docs/decode-scouting-rules.md.
//
// Auto Scouting is phase-free: the detector runs continuously through the video
// and every artifact entering a goal scores the same +3, so there is no match-
// timing/phase model here anymore.

export const DECODE_RULES = {
  manualVersion: "V9 (2025-2026 Competition Manual)",
  teamUpdate: "32",

  points: {
    artifactClassified: 3, // Table 10-2: CLASSIFIED artifact
    artifactOverflow: 1, // Table 10-2: OVERFLOW artifact
    artifactDepot: 1, // Table 10-2: DEPOT artifact
    patternPerArtifact: 2, // Table 10-2: each RAMP artifact matching the MOTIF
    leavePerRobot: 3, // Table 10-2: LEAVE (per robot)
    basePartialPerRobot: 5, // Table 10-2: partially returned to BASE
    baseFullPerRobot: 10, // Table 10-2: fully returned to BASE
    baseBothFullBonus: 10, // Table 10-2: bonus when both robots fully returned
  },

  // The MOTIF is one of three arrangements, repeated 3x across the 9 RAMP indices
  // (Figure 10-4). Used only for the manual pattern-entry helper.
  motifs: ["GPP", "PGP", "PPG"] as const,

  // NOTE: This prompt's text stated overflow artifacts are worth 3 points, but the
  // official manual (Table 10-2) lists OVERFLOW as 1 point. The prompt itself
  // directs that official FIRST sources are the source of truth over its own
  // assumptions, so the official value (1) is used above. Change `artifactOverflow`
  // here if a later Team Update revises it — it is the only place the value lives.
} as const;
