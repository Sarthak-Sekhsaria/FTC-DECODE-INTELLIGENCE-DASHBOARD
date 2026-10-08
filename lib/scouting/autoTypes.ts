// Data model for an Auto Scouting session. Everything here is in-memory only —
// per the feature spec, auto-scouting outputs are ephemeral and never written to
// disk. Scores are always DERIVED from events + manual entries via
// computeAllianceScore so a correction instantly and consistently recomputes
// totals.
//
// There is NO match-phase concept here: the detector runs continuously and every
// artifact entering a goal scores the same +3 regardless of the video timestamp.

import { DECODE_RULES } from "./decodeRules.ts";

export type AllianceColor = "red" | "blue";
export type ArtifactColor = "purple" | "green" | "unknown";
export type ArtifactScoreType = "classified" | "overflow";
export type DetectionMethod = "cv" | "manual";
export type ReviewStatus = "auto" | "confirmed" | "rejected";
export type Confidence = "high" | "medium" | "low";

// A single scoring event — either detected by the CV pass or added manually.
// The original detection is never mutated in place: corrections set `status`
// and/or override fields, keeping an audit trail. No `phase` field — artifact
// events are never classified as autonomous or teleop.
export interface ScoreEvent {
  id: string;
  videoTime: number; // seconds into the video
  alliance: AllianceColor;
  type: ArtifactScoreType;
  color: ArtifactColor;
  points: number;
  method: DetectionMethod;
  status: ReviewStatus;
  confidence: Confidence;
  source?: "ramp_queue" | "scoreboard" | "gate_detection" | "manual" | "test"; // provenance for the debug log
  zoneX?: number; // centre-x of the crossing within the crop (de-dups replays)
  trackId?: number;
  count?: number; // artifacts represented by this event (>1 for a merged clump)
  note?: string;
}

export type RobotBaseStatus = "none" | "partial" | "full";

// Manual, non-detected scoring inputs. These are retained as separate inputs
// (pattern / leave / endgame BASE / free adjustment) but are NOT match phases.
export interface AllianceManualEntry {
  robotsLeft: number; // 0-2, LEAVE
  patternArtifacts: number; // # RAMP artifacts matching MOTIF (x patternPerArtifact)
  baseRobot1: RobotBaseStatus;
  baseRobot2: RobotBaseStatus;
  manualAdjustment: number; // free +/- point correction
}

export function emptyManualEntry(): AllianceManualEntry {
  return {
    robotsLeft: 0,
    patternArtifacts: 0,
    baseRobot1: "none",
    baseRobot2: "none",
    manualAdjustment: 0,
  };
}

export interface AllianceScore {
  artifacts: number; // count of accepted artifact events
  artifactPoints: number; // sum of accepted artifact event points (classified = 3)
  patternPoints: number;
  leavePoints: number;
  endgamePoints: number; // BASE (manually entered)
  manualAdjustment: number;
  total: number;
}

export interface AutoSession {
  videoName: string;
  videoDurationSeconds: number;
  videoWidth: number;
  videoHeight: number;
  redSide: "left" | "right"; // which half of the frame holds the RED goal zone
  events: ScoreEvent[];
  red: AllianceManualEntry;
  blue: AllianceManualEntry;
}

function basePoints(status: RobotBaseStatus): number {
  if (status === "full") return DECODE_RULES.points.baseFullPerRobot;
  if (status === "partial") return DECODE_RULES.points.basePartialPerRobot;
  return 0;
}

function endgamePoints(entry: AllianceManualEntry): number {
  let pts = basePoints(entry.baseRobot1) + basePoints(entry.baseRobot2);
  if (entry.baseRobot1 === "full" && entry.baseRobot2 === "full") {
    pts += DECODE_RULES.points.baseBothFullBonus;
  }
  return pts;
}

// Derive an alliance's full score from the accepted events + its manual entries.
// Rejected events are excluded; confirmed and still-auto events both count. Every
// accepted artifact event contributes regardless of when in the video it occurred.
export function computeAllianceScore(
  color: AllianceColor,
  events: ScoreEvent[],
  entry: AllianceManualEntry,
): AllianceScore {
  const accepted = events.filter((e) => e.alliance === color && e.status !== "rejected");

  // A single detection event can represent a merged clump of several artifacts
  // (count > 1), so artifacts sum the per-event counts, not just the event count.
  const artifacts = accepted.reduce((s, e) => s + (e.count ?? 1), 0);
  const artifactPoints = accepted.reduce((s, e) => s + e.points, 0);

  const patternPoints = entry.patternArtifacts * DECODE_RULES.points.patternPerArtifact;
  const leavePoints = entry.robotsLeft * DECODE_RULES.points.leavePerRobot;
  const eg = endgamePoints(entry);

  const total = artifactPoints + patternPoints + leavePoints + eg + entry.manualAdjustment;

  return {
    artifacts,
    artifactPoints,
    patternPoints,
    leavePoints,
    endgamePoints: eg,
    manualAdjustment: entry.manualAdjustment,
    total,
  };
}

export function artifactPointsFor(type: ArtifactScoreType): number {
  return type === "classified"
    ? DECODE_RULES.points.artifactClassified
    : DECODE_RULES.points.artifactOverflow;
}
