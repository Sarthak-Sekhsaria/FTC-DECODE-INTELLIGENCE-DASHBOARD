"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AutoVideoPlayer, { type Zone } from "./components/AutoVideoPlayer";
import Scoreboard from "./components/Scoreboard";
import EventList from "./components/EventList";
import ManualPanel from "./components/ManualPanel";
import AutoReport from "./components/AutoReport";
import {
  analyzeZonePixels,
  detectCandidates,
  computeMaskImage,
  GateMultiTracker,
  sideOfLine,
  targetFromSample,
  DEFAULT_TARGETS,
  DEFAULT_CANDIDATE_CONFIG,
  type ColorTarget,
  type Candidate,
  type CandidateConfig,
  type CrossingEvent,
  type ScoringDirection,
  type TrackerConfig,
} from "@/lib/scouting/cvDetector";
import DebugPanel, { type GateDiag, type Diag } from "./components/DebugPanel";
import RampDebug from "./components/RampDebug";
import RampCalibration from "./components/RampCalibration";
import {
  computeAllianceScore,
  emptyManualEntry,
  artifactPointsFor,
  type AllianceColor,
  type AllianceManualEntry,
  type ScoreEvent,
} from "@/lib/scouting/autoTypes";
import { DECODE_RULES } from "@/lib/scouting/decodeRules";
import RoiPlacementPanel, { type PlacementStage, type PlacementSummary } from "./components/RoiPlacementPanel";
import PlacementOverlay, { type OverlayDebug, type OverlayRoi } from "./components/PlacementOverlay";
import { loadOpenCV } from "@/lib/scouting/placement/cv";
import { getFieldModel } from "@/lib/scouting/placement/fieldModel";
import { aggregatePlacements, placeFromTaps, runPlacement, DEFAULT_PLACEMENT_CONFIG, type FramePlacement, type LockedPlacement, type MethodId } from "@/lib/scouting/placement/placer";
import { CameraMotionMonitor } from "@/lib/scouting/placement/cameraMotion";
import { appendPlacementLog, loadPlacement, readPlacementLog, savePlacement, videoKey, type SavedPlacement } from "@/lib/scouting/placement/persist";
import type { FrameImage } from "@/lib/scouting/placement/apriltag";
import { intrinsicsFromFov, type Vec2 } from "@/lib/scouting/placement/geometry";
import type { CameraSolution } from "@/lib/scouting/calibration";
import { counterScale, RampScorer, resizedCamera, scaleLaneViews, type LaneView, type RampAutoParams, type RampResult } from "@/lib/scouting/rampScorer";
import { MATCH_SEC, SETTLE_SEC, type MatchWindow } from "@/lib/scouting/matchClock";
import { POST_MAX_SEC, readScoreBar, ScoreBarTracker, unpackDigits, type PackedDigits, type ScoreBarCounts, type ScoreBarWindow } from "@/lib/scouting/scoreboard";
import scoreboardDigits from "@/lib/scouting/scoreboardDigits.json";
import { loadRampModels } from "@/lib/scouting/rampModels";
import { MIN_RELIABLE_ARTIFACT_PX, RampCounterV2 } from "@/lib/scouting/rampCounterV2";

type Processing = "idle" | "analyzing" | "done";

// Finer sampling catches fast artifacts (they can cross a gate between coarse
// frames) at the cost of more seeks. "Thorough" is the default because accuracy
// matters more than speed for scouting.
const DETAIL_STEPS = { fast: 0.12, balanced: 0.07, thorough: 0.04 } as const;
type Detail = keyof typeof DETAIL_STEPS;

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtCs(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00.00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

// A box over each alliance's RAMP. Artifacts roll down it from the goal and cross
// the scoring line. Only these two boxes are ever analyzed — never the full field.
// These defaults are only placeholders: automatic ROI placement (lib/scouting/
// placement) projects the real RAMP from the field model as soon as a video loads.
const DEFAULT_RED_ZONE: Zone = { x: 0.63, y: 0.03, w: 0.09, h: 0.4, line: 0.5 };
const DEFAULT_BLUE_ZONE: Zone = { x: 0.28, y: 0.03, w: 0.08, h: 0.42, line: 0.5 };
// Goal tubes sit in shadow, so sensitivity defaults are raised to see dim balls — but
// NOT so high that pre-match staging, reflections or robot lights read as artifacts.
// Each gate pairs a default sensitivity with its own colour floor (see RED_COLOR_FLOORS
// / BLUE_COLOR_FLOORS). Both tubes were under-counting because the old fixed floors
// clamped the slider once cranked, so both now default to 4 with lower per-gate floors
// the slider can actually reach. Always Set a match start after any intro so the
// pre-match green graphic can't score. Push a slider higher only if that gate still
// under-counts.
const DEFAULT_RED_SENSITIVITY = 4;
const DEFAULT_BLUE_SENSITIVITY = 4;
const MAX_SENSITIVITY = 5;
// Multi-count (clump) size — normalized area of ONE artifact in a gate crop; a
// crossing blob bigger than ~1.6x this is scored as several balls (round(area /
// single)). DEFAULT OFF (0): it roughly reproduces the true match total but triples
// counts on some crossings, which overshoots locally and amplifies noise. Each gate
// counts one ball per crossing by default — accurate and stable. Raise the Debug
// "clump size" sliders (start low, e.g. 0.015) only to push a total toward the real
// score, accepting some overshoot. Suggested tuned values: red 0.013, blue 0.015.
const DEFAULT_RED_SINGLE_AREA = 0.008; // RED-ONLY clump multiplier (dim tube undercounts); capped by DEFAULT_RED_MAX_CLUMP
const DEFAULT_BLUE_SINGLE_AREA = 0; // BLUE stays clean-count (verified perfect on test footage — do not change)
// Cap on balls a single blob may represent, per gate. Kept tight on BOTH gates: an
// uncapped cap let one noisy blob (e.g. a pre-match cluster) score 10-20 at once,
// which caused the overshoot and pre-match false scoring. A real touching-ball burst
// is small, so 3 is plenty.
const DEFAULT_RED_MAX_CLUMP = 3;
const DEFAULT_BLUE_MAX_CLUMP = 3;

function trackerCfgFrom(zone: Zone, direction: ScoringDirection, singleArtifactArea: number, maxClump: number): TrackerConfig {
  return {
    line: zone.line,
    direction,
    maxMatchDist: 0.45,
    maxMissing: 6,
    singleArtifactArea: singleArtifactArea > 0 ? singleArtifactArea : undefined,
    maxClump,
  };
}

// Saturation/brightness floor clamps, PER GATE. A pixel greyer/darker than these is
// never classified as an artifact, so these set the hard ceiling on what a gate's
// sensitivity slider can ever see: once 0.25/s and 0.18/s drop below the clamp, raising
// the slider does nothing. Both goal tubes sit in shadow and were clamped at the old
// 0.10/0.08 floors, so both under-counted their dim balls once the slider was cranked.
// Each gate now has its own lower floor its slider can actually reach. RED sits in
// DEEPER shadow (≈90-pt undercount) so it goes lowest; BLUE needs a gentler lift
// (≈40-pt undercount) and must not overshoot, so its floor is only moderately lower.
// Both tuned per gate against the da Vinci Finals 1 footage. The pre-match green intro —
// the reason these floors were high originally — is excluded by the Match-start gate
// instead, so set a match start after any intro before trusting a live total.
const RED_COLOR_FLOORS = { minSat: 0.05, minVal: 0.045 };   // deeper shadow — DO NOT change without re-testing red
const BLUE_COLOR_FLOORS = { minSat: 0.065, minVal: 0.053 }; // gentler lift for blue's ~40-pt undercount

// Higher sensitivity lowers the colour-coverage, minimum-blob-size AND (down to the
// per-gate floor) the saturation/brightness floors, so fainter / darker artifacts
// (e.g. balls in a shadowed goal tube) still register as candidates. Applied per gate
// so a dim goal can be turned up without adding noise on a bright one.
function candidateCfgFrom(
  targets: ColorTarget[],
  sensitivity: number,
  floors: { minSat: number; minVal: number } = BLUE_COLOR_FLOORS,
): CandidateConfig {
  const s = Math.max(0.5, sensitivity);
  return {
    ...DEFAULT_CANDIDATE_CONFIG,
    targets,
    minSat: Math.max(floors.minSat, 0.25 / s),
    minVal: Math.max(floors.minVal, 0.18 / s),
    minCoverage: 0.03 / s,
    minAreaFrac: 0.012 / s,
  };
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    // Seeking to the current position fires no "seeked" event — resolve at once.
    if (Math.abs(video.currentTime - t) < 1e-3 && !video.seeking) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    window.setTimeout(finish, 4000); // never hang on a stuck decoder
    video.currentTime = t;
  });
}

// RAMP queue counter: the evidence rate it decodes at (rampQueue DEFAULT fps).
const RAMP_FPS = 15;
// Live mode: more playback than this between two counted frames means the browser held frames
// back (see the live RAMP loop). A throttled page gets its timers about once a second, so this
// sits below that; a device that counts at least ~1.5 frames a second never reaches it.
const LIVE_STALL_SEC = 0.75;
// Live counting plays the video slower (down to LIVE_MIN_RATE) when the device cannot count
// every frame in real time; the share of frames counted is judged over LIVE_RATE_SPAN_SEC of video.
const LIVE_MIN_RATE = 0.25;
const LIVE_RATE_SPAN_SEC = 2;
// the share of the page's time live counting aims to use: the rest is decoding, drawing and the page
const LIVE_TARGET_LOAD = 0.6;

// The window ARTIFACTS are scored in. What the user set wins, and a start alone puts the buzzer
// MATCH_SEC later (CM §10.4: 30 s AUTO, 8 s transition, 2:00 TELEOP). Next comes the clock on a
// broadcast's score bar (scoreboard.ts), exact as soon as TELEOP is seen. Otherwise it is the
// window found from the robots' motion on the FIELD (matchClock.ts), which gives a buzzer only
// once it is final. ARTIFACTS still in the air at the buzzer count when they come to rest
// (CM §10.5 A), so scoring runs SETTLE_SEC past the buzzer and nothing later counts.
interface ScoringWindow {
  start: number;
  buzzer: number | null;
  source: "manual" | "start" | "scoreboard" | "auto" | "detecting";
}

function scoringWindowOf(manualStart: number, manualEnd: number | null, auto: MatchWindow | null, bar: ScoreBarWindow | null = null): ScoringWindow {
  const startSet = manualStart > 0;
  if (manualEnd != null) return { start: startSet ? manualStart : (bar?.start ?? auto?.start ?? 0), buzzer: manualEnd, source: "manual" };
  if (startSet) return { start: manualStart, buzzer: manualStart + MATCH_SEC, source: "start" };
  if (bar) return { start: bar.start, buzzer: bar.buzzer, source: "scoreboard" };
  if (auto?.final) return { start: auto.start, buzzer: auto.buzzer, source: "auto" };
  return { start: 0, buzzer: null, source: "detecting" };
}

// Where the scoring window came from, for the status line and the log.
function windowSourceText(source: ScoringWindow["source"]): string {
  return source === "scoreboard" ? "read from the score bar's clock" : source === "auto" ? "found from the field" : "set by hand";
}

// When scoring stops. ARTIFACTS still in the air at the buzzer count for SETTLE_SEC. With the
// score bar, the scorekeepers' last entries after the buzzer count too: scoring runs until the
// bar's counts have settled (ScoreBarTracker.settledAt) and is not over before that is known.
function scoringEndOf(w: ScoringWindow, bar: ScoreBarTracker): number | null {
  if (w.buzzer == null) return null;
  if (w.source !== "scoreboard" || !bar.countsReadable) return w.buzzer + SETTLE_SEC;
  const settled = bar.settledAt();
  return settled == null ? null : Math.max(settled, w.buzzer + SETTLE_SEC);
}

function sameBarWindow(a: ScoreBarWindow | null, b: ScoreBarWindow | null): boolean {
  return a === b || (!!a && !!b && a.final === b.final && Math.abs(a.buzzer - b.buzzer) < 1e-6 && Math.abs(a.start - b.start) < 1e-6);
}

// The digit templates of the score bar reader (scoreboardDigits.json), unpacked once.
const BAR_DIGITS = unpackDigits(scoreboardDigits as PackedDigits);

// development only: the v2 models, for timing them from the browser console
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") (window as unknown as { __loadRampModels?: typeof loadRampModels }).__loadRampModels = loadRampModels;

// When the broadcast's score bar is in the video, the scored ARTIFACTS are the scorekeepers'
// counts read from it: one event per ARTIFACT at the time its count went up (classified 3
// points, overflow 1), up to `until`.
function scoreBarEvents(bar: ScoreBarTracker, until: number): ScoreEvent[] {
  return (["red", "blue"] as const).flatMap((alliance) =>
    (["classified", "overflow"] as const).flatMap((kind) =>
      bar.scoringTimes(alliance, kind, until).map((t, i) => ({
        id: `bar_${alliance}_${kind}_${i}`,
        videoTime: t,
        alliance,
        type: kind,
        color: "unknown" as const,
        points: artifactPointsFor(kind),
        method: "cv" as const,
        status: "auto" as const,
        confidence: "high" as const,
        source: "scoreboard" as const,
        count: 1,
        note: "Official count read from the broadcast score bar",
      })),
    ),
  );
}

function sameWindow(a: MatchWindow | null, b: MatchWindow | null): boolean {
  return a === b || (!!a && !!b && a.final === b.final && Math.abs(a.buzzer - b.buzzer) < 1e-6 && Math.abs(a.start - b.start) < 1e-6);
}

// One event per CLASSIFIED ARTIFACT the RAMP counter found. Ids are stable across the
// provisional re-counts of a live run, so a reviewer's corrections survive them.
function rampEvents(results: RampResult[]): ScoreEvent[] {
  return results.flatMap((r) =>
    r.count.artifacts.map((a, i) => ({
      id: `ramp_${r.alliance}_${a.frame}_${i}`,
      videoTime: r.t0 + a.frame / r.fps,
      alliance: r.alliance,
      type: "classified" as const,
      color: a.colour,
      points: artifactPointsFor("classified"),
      method: "cv" as const,
      status: "auto" as const,
      confidence: r.count.quality.confidence,
      source: "ramp_queue" as const,
      count: 1,
      note: a.source === "entry" ? "Rolled through an open GATE" : undefined,
    })),
  );
}

// One event per ARTIFACT the v2 counter saw come onto a RAMP in the window (rampCounterV2.ts).
function v2Events(v2: RampCounterV2, alliances: ("red" | "blue")[], start: number, until: number): ScoreEvent[] {
  return alliances.flatMap((alliance) =>
    v2.events(alliance, start, until).map((e, i) => ({
      id: `v2_${alliance}_${i}`,
      videoTime: e.t,
      alliance,
      type: "classified" as const,
      color: "unknown" as const,
      points: artifactPointsFor("classified"),
      method: "cv" as const,
      status: "auto" as const,
      confidence: "medium" as const,
      source: "ramp_queue" as const,
      count: 1,
      note: "Came onto the RAMP (v2 counter)",
    })),
  );
}

let eventCounter = 0;
function nextId(): string {
  eventCounter += 1;
  return `ev_${Date.now()}_${eventCounter}`;
}

function ZoneControls({
  label,
  color,
  zone,
  onChange,
}: {
  label: string;
  color: string;
  zone: Zone;
  onChange: (z: Zone) => void;
}) {
  const rows: { key: keyof Zone; name: string; min: number; max: number }[] = [
    { key: "x", name: "Left", min: 0, max: 0.92 },
    { key: "y", name: "Top", min: 0, max: 0.92 },
    { key: "w", name: "Width", min: 0.05, max: 0.6 },
    { key: "h", name: "Height", min: 0.05, max: 0.9 },
    { key: "line", name: "Scoring line", min: 0.05, max: 0.95 },
  ];
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: color }}>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
        {label}
      </p>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <label key={r.key} className="grid grid-cols-[70px_1fr] items-center gap-2 text-[11px] text-white/50">
            {r.name}
            <input
              type="range"
              min={r.min}
              max={r.max}
              step={0.01}
              value={zone[r.key]}
              onChange={(e) => onChange({ ...zone, [r.key]: Number(e.target.value) })}
              style={{ accentColor: color }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// Paint a gate crop into the debug canvas and overlay detection graphics: the
// scoring line, direction arrow, field/goal labels, and every detected candidate
// (bounding box + centre + id + colour). A COUNTED flash is drawn on a crossing.
function drawCropWithOverlay(
  canvas: HTMLCanvasElement | null,
  data: Uint8ClampedArray | null,
  w: number,
  h: number,
  candidates: Candidate[],
  line: number,
  direction: ScoringDirection,
  flash: boolean,
) {
  if (!canvas || !data || w === 0 || h === 0) return;
  // Draw at an upscaled resolution so the overlay text/lines are legible.
  const scale = Math.max(1, Math.round(280 / w));
  const cw = w * scale;
  const ch = h * scale;
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Base image (nearest-neighbour upscale).
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  if (tctx) {
    const img = tctx.createImageData(w, h);
    img.data.set(data);
    tctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, cw, ch);
  }

  // Scoring line.
  const ly = line * ch;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(0, ly);
  ctx.lineTo(cw, ly);
  ctx.stroke();
  ctx.setLineDash([]);

  // Direction arrow (which way across the line scores) + field/goal labels.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `bold ${Math.round(ch * 0.11)}px sans-serif`;
  const arrow = direction === "downward" ? "▼ scores" : "▲ scores";
  ctx.fillText(arrow, cw - ctx.measureText(arrow).width - 4, ly - 4);
  ctx.fillStyle = "rgba(120,200,255,0.75)";
  ctx.fillText("field", 4, direction === "downward" ? ly - 6 : ch - 6);
  ctx.fillStyle = "rgba(120,255,170,0.8)";
  ctx.fillText("goal", 4, direction === "downward" ? ch - 6 : ly + Math.round(ch * 0.12) + 2);

  // Candidates.
  candidates.forEach((c, i) => {
    const bx = (c.centerX - c.width / 2) * cw;
    const by = (c.centerY - c.height / 2) * ch;
    const bw = c.width * cw;
    const bh = c.height * ch;
    const stroke = c.color === "green" ? "#3bff88" : "#c07bff";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    // centre point
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.arc(c.centerX * cw, c.centerY * ch, 3, 0, Math.PI * 2);
    ctx.fill();
    // id label
    ctx.fillStyle = "#000";
    ctx.fillRect(bx, by - Math.round(ch * 0.13), Math.round(ch * 0.16), Math.round(ch * 0.13));
    ctx.fillStyle = stroke;
    ctx.font = `bold ${Math.round(ch * 0.11)}px sans-serif`;
    ctx.fillText(`A${i + 1}`, bx + 2, by - 3);
  });

  if (flash) {
    ctx.fillStyle = "rgba(34,255,160,0.85)";
    ctx.font = `900 ${Math.round(ch * 0.16)}px sans-serif`;
    ctx.fillText("COUNTED +3", 6, ch / 2);
  }
}

export default function AutoScoutingPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cancelRef = useRef(false);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState("");
  const [meta, setMeta] = useState({ duration: 0, width: 0, height: 0 });
  const [redZone, setRedZone] = useState<Zone>(DEFAULT_RED_ZONE);
  const [blueZone, setBlueZone] = useState<Zone>(DEFAULT_BLUE_ZONE);

  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [red, setRed] = useState<AllianceManualEntry>(emptyManualEntry());
  const [blue, setBlue] = useState<AllianceManualEntry>(emptyManualEntry());

  const [processing, setProcessing] = useState<Processing>("idle");
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [showReport, setShowReport] = useState(false);

  // Scoring window: artifacts only count between match start and the buzzer. When
  // playback reaches the buzzer, scoring stops, the video pauses, and results show.
  const [matchStart, setMatchStart] = useState(0);
  const [matchEnd, setMatchEnd] = useState<number | null>(null); // null = no buzzer set
  const [matchComplete, setMatchComplete] = useState(false);

  const [colorTargets, setColorTargets] = useState<ColorTarget[]>(DEFAULT_TARGETS);
  const [sampleMode, setSampleMode] = useState<"purple" | "green" | null>(null);
  const [detail, setDetail] = useState<Detail>("thorough");
  // Per-gate detection sensitivity (higher = catches dimmer/smaller artifacts).
  const [redSensitivity, setRedSensitivity] = useState(DEFAULT_RED_SENSITIVITY);
  const [blueSensitivity, setBlueSensitivity] = useState(DEFAULT_BLUE_SENSITIVITY);
  const [redSingleArea, setRedSingleArea] = useState(DEFAULT_RED_SINGLE_AREA); // 0 = off
  const [blueSingleArea, setBlueSingleArea] = useState(DEFAULT_BLUE_SINGLE_AREA);
  const [liveOn, setLiveOn] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [redDir, setRedDir] = useState<ScoringDirection>("downward");
  const [blueDir, setBlueDir] = useState<ScoringDirection>("downward");

  // ---- RAMP queue counter (lib/scouting/rampScorer) ----
  // Needs the camera pose from ROI placement (in the lock frame). Manually drawn boxes have no
  // pose, so they (or a debug override) use the legacy gate-line detector.
  const [placementCam, setPlacementCam] = useState<CameraSolution | null>(null);
  const placementCamRef = useRef<CameraSolution | null>(null);
  useEffect(() => { placementCamRef.current = placementCam; }, [placementCam]);
  const [forceLegacy, setForceLegacy] = useState(false);
  const [rampAuto, setRampAuto] = useState<RampAutoParams[]>([]);
  const [rampResults, setRampResults] = useState<RampResult[]>([]);
  // the match window found from the field by the RAMP counter (matchClock.ts)
  const [autoWindow, setAutoWindow] = useState<MatchWindow | null>(null);
  const autoWindowRef = useRef<MatchWindow | null>(null);
  // the broadcast's score bar, read twice a second while counting (scoreboard.ts)
  const barRef = useRef(new ScoreBarTracker());
  const barReadAtRef = useRef(-Infinity);
  const [barWindow, setBarWindow] = useState<ScoreBarWindow | null>(null);
  const barWindowRef = useRef<ScoreBarWindow | null>(null);
  const [barCounts, setBarCounts] = useState<ScoreBarCounts | null>(null);
  const [barSettledAt, setBarSettledAt] = useState<number | null>(null); // the score bar's counts final (after the buzzer)
  // what the RAMP counter found, shown beside the score bar's counts as a check
  const [visionCounts, setVisionCounts] = useState<{ red: number; blue: number } | null>(null);
  const [laneViews, setLaneViews] = useState<LaneView[]>([]);
  const scorerRef = useRef<RampScorer | null>(null);
  // the v2 counter (null until its models are loaded, or if they cannot be: then v1 scores)
  const v2Ref = useRef<RampCounterV2 | null>(null);
  const [v2State, setV2State] = useState<"off" | "loading" | "ready" | "failed">("off");
  // share of the match each RAMP was seen in (followed and recognised as a RAMP), v2 counter
  // per RAMP: the share of the match it was seen, and the counter's estimate where it is not
  // scored (too small in the picture)
  const [v2Seen, setV2Seen] = useState<{ alliance: "red" | "blue"; share: number; unscored: number | null }[]>([]);
  // the RAMP counter's working frame size (see counterScale): every frame it gets is this size
  const counterSizeRef = useRef<{ width: number; height: number } | null>(null);
  const counterCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---- automatic RAMP ROI placement (see lib/scouting/placement) ----
  const [placeStage, setPlaceStage] = useState<PlacementStage>("idle");
  const [placeProgress, setPlaceProgress] = useState<{ attempts: number; usable: number; target: number } | null>(null);
  const [placeSummary, setPlaceSummary] = useState<PlacementSummary | null>(null);
  const [placeFailure, setPlaceFailure] = useState<string | null>(null);
  const [overlayRois, setOverlayRois] = useState<OverlayRoi[]>([]);
  const [overlayDebug, setOverlayDebug] = useState<OverlayDebug | null>(null);
  const [fieldDebug, setFieldDebug] = useState(false);
  const [taps, setTaps] = useState<Vec2[] | null>(null);
  const [redEnabled, setRedEnabled] = useState(true);
  const [blueEnabled, setBlueEnabled] = useState(true);
  const redEnabledRef = useRef(true);
  const blueEnabledRef = useRef(true);
  useEffect(() => { redEnabledRef.current = redEnabled; }, [redEnabled]);
  useEffect(() => { blueEnabledRef.current = blueEnabled; }, [blueEnabled]);
  const fileKeyRef = useRef<string | null>(null);
  const placeRunRef = useRef(0); // bumps to cancel an in-flight placement run
  const lockTimeRef = useRef(0);
  const lockedRef = useRef<{ placement: FramePlacement | null; method: MethodId } | null>(null);
  const placeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionRef = useRef<CameraMotionMonitor | null>(null);
  const fieldModel = useMemo(() => {
    try {
      return getFieldModel();
    } catch (e) {
      console.error(e);
      return null;
    }
  }, []);

  // Live-config refs so the per-frame loop reads current detection params without
  // being torn down on every sensitivity/colour tweak.
  const colorTargetsRef = useRef(colorTargets);
  const redSensRef = useRef(redSensitivity);
  const blueSensRef = useRef(blueSensitivity);
  const redSingleRef = useRef(redSingleArea);
  const blueSingleRef = useRef(blueSingleArea);
  const debugModeRef = useRef(false);
  const matchStartRef = useRef(matchStart);
  const matchEndRef = useRef(matchEnd);
  const matchEndedRef = useRef(false); // one-shot guard for the auto-pause at the buzzer
  useEffect(() => { colorTargetsRef.current = colorTargets; }, [colorTargets]);
  useEffect(() => { redSensRef.current = redSensitivity; }, [redSensitivity]);
  useEffect(() => { blueSensRef.current = blueSensitivity; }, [blueSensitivity]);
  useEffect(() => { redSingleRef.current = redSingleArea; }, [redSingleArea]);
  useEffect(() => { blueSingleRef.current = blueSingleArea; }, [blueSingleArea]);
  useEffect(() => { debugModeRef.current = debugMode; }, [debugMode]);
  useEffect(() => { matchStartRef.current = matchStart; }, [matchStart]);
  useEffect(() => { matchEndRef.current = matchEnd; }, [matchEnd]);

  const lastMediaTimeRef = useRef(-1);
  const scoredUpToRef = useRef(-1); // high-water mark: only NEW footage creates events
  const redCropRef = useRef<HTMLCanvasElement | null>(null);
  const blueCropRef = useRef<HTMLCanvasElement | null>(null);
  const redMaskRef = useRef<HTMLCanvasElement | null>(null);
  const blueMaskRef = useRef<HTMLCanvasElement | null>(null);

  const emptyGateDiag: GateDiag = {
    detector: "inactive",
    candidates: 0,
    crossingThisFrame: 0,
    totalCrossings: 0,
    present: false,
    lastEvent: null,
    flashWall: 0,
  };
  const diagRef = useRef<Diag>({
    framesAnalyzed: 0,
    lastProcessedTime: 0,
    status: "Waiting for video",
    red: { ...emptyGateDiag },
    blue: { ...emptyGateDiag },
    log: [],
  });
  const [diag, setDiag] = useState<Diag>(diagRef.current);

  const videoAspect = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : 0;

  useEffect(() => {
    if (!videoUrl) return;
    return () => URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setMeta({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
    };
  }, [videoUrl]);

  function handleUpload(file: File) {
    // New video: cancel any placement run and start fresh (placement runs once the
    // video metadata is known — see the effect below).
    placeRunRef.current++;
    motionRef.current?.dispose();
    motionRef.current = null;
    fileKeyRef.current = videoKey(file);
    autoPlacedForRef.current = null;
    setPlaceStage("idle");
    setPlaceSummary(null);
    setPlaceFailure(null);
    setOverlayRois([]);
    setOverlayDebug(null);
    setTaps(null);
    setLiveOn(false);
    setPlacementCam(null);
    resetScorer();
    setVideoUrl(URL.createObjectURL(file));
    setVideoName(file.name);
    setEvents([]);
    setProcessing("idle");
    setProgress(0);
    setMatchStart(0);
    setMatchEnd(null);
    setMatchComplete(false);
    matchEndedRef.current = false;
  }

  const redScore = useMemo(() => computeAllianceScore("red", events, red), [events, red]);
  const blueScore = useMemo(() => computeAllianceScore("blue", events, blue), [events, blue]);

  // ---- automatic RAMP ROI placement -------------------------------------------
  const liveOnRef = useRef(false);
  const processingRef = useRef<Processing>("idle");
  useEffect(() => { liveOnRef.current = liveOn; }, [liveOn]);
  useEffect(() => { processingRef.current = processing; }, [processing]);
  const autoPlacedForRef = useRef<string | null>(null);

  // Whatever the video currently shows: the full native-resolution frame, or (`size`) the
  // frame resized for the RAMP counter (high-quality downscale, on its own canvas).
  function grabCurrentFrame(size?: { width: number; height: number } | null): FrameImage | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const scaled = !!size && (size.width !== v.videoWidth || size.height !== v.videoHeight);
    const ref = scaled ? counterCanvasRef : placeCanvasRef;
    const c = ref.current ?? (ref.current = document.createElement("canvas"));
    const w = scaled ? size!.width : v.videoWidth, h = scaled ? size!.height : v.videoHeight;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    if (scaled) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return { data: img.data, width: img.width, height: img.height };
  }

  async function grabFrameAt(t: number, size?: { width: number; height: number } | null): Promise<FrameImage | null> {
    const v = videoRef.current;
    if (!v) return null;
    await seekTo(v, Math.max(0, Math.min(t, (v.duration || t) - 0.01)));
    return grabCurrentFrame(size);
  }

  function applyRois(rois: { alliance: AllianceColor; quad: Vec2[] | null; zone: Zone; direction: ScoringDirection }[]) {
    const clampZone = (z: Zone): Zone => ({ ...z, x: Math.max(0, z.x), y: Math.max(0, z.y), w: Math.min(z.w, 1 - Math.max(0, z.x)), h: Math.min(z.h, 1 - Math.max(0, z.y)) });
    const red = rois.find((r) => r.alliance === "red");
    const blue = rois.find((r) => r.alliance === "blue");
    if (red) {
      setRedZone(clampZone(red.zone));
      setRedDir(red.direction);
    }
    if (blue) {
      setBlueZone(clampZone(blue.zone));
      setBlueDir(blue.direction);
    }
    // Only a ramp that is actually in view gets a counting zone.
    setRedEnabled(!!red);
    setBlueEnabled(!!blue);
    setOverlayRois(rois.filter((r) => r.quad).map((r) => ({ alliance: r.alliance, quad: r.quad! })));
  }

  function summaryOf(L: LockedPlacement, restored = false): PlacementSummary {
    return {
      method: L.method,
      assistedBy: L.representative.assistedBy,
      reprojError: L.reprojError,
      fovDeg: L.fovDeg,
      fovRefined: L.fovRefined,
      fovWellConstrained: L.fovWellConstrained,
      framesUsed: L.framesUsed,
      framesTried: L.framesTried,
      confidence: L.confidence,
      notes: L.confidenceNotes,
      alliances: L.rois.map((r) => r.alliance),
      nudged: false,
      restored,
    };
  }

  function debugOf(p: FramePlacement, method: string, err: number | null): OverlayDebug {
    return {
      method,
      reprojError: err,
      fovDeg: p.solution.intrinsics.fovDeg,
      pose: p.solution.pose,
      intrinsics: p.solution.intrinsics,
      tags: p.tags,
      fieldPlane: p.fieldPlane,
      correspondences: p.correspondences,
    };
  }

  // Every run is logged (debug log, console, and a persistent list included in the
  // debug export) with the method that succeeded and its reprojection error.
  function logPlacement(method: MethodId | "none", L: LockedPlacement | null, note?: string) {
    const entry = {
      at: new Date().toISOString(),
      video: videoName || fileKeyRef.current || "?",
      method,
      reprojError: L ? L.reprojError : null,
      fovDeg: L ? L.fovDeg : null,
      framesUsed: L ? L.framesUsed : 0,
      framesTried: L ? L.framesTried : 0,
      confidence: L ? L.confidence : ("failed" as const),
      note,
    };
    appendPlacementLog(entry);
    console.info("[ROI placement]", entry);
    pushLog(
      L
        ? `[ROI] method ${method}${L.representative.assistedBy ? "+grid" : ""} · reproj ${L.reprojError.toFixed(2)} px · FOV ${L.fovDeg.toFixed(1)}° · frames ${L.framesUsed}/${L.framesTried} · ${L.confidence} confidence`
        : `[ROI] automatic placement failed — ${note ?? "unknown"}`,
    );
  }

  // Run automatic placement (A: AprilTag, then B: field plane, per frame; median-
  // locked over the first usable frames). Never runs while counting is running.
  async function startPlacement(fromTime = 0, force = false) {
    const v = videoRef.current;
    if (!v || !fieldModel) return;
    if (!force && (liveOnRef.current || processingRef.current === "analyzing")) return;
    const run = ++placeRunRef.current;
    motionRef.current?.dispose();
    motionRef.current = null;
    v.pause();
    const resumeAt = v.currentTime;
    setPlaceStage("finding");
    setPlaceProgress(null);
    setPlaceFailure(null);
    setPlaceSummary(null);
    setPlacementCam(null);
    resetScorer();
    setTaps(null);
    setOverlayRois([]);
    setOverlayDebug(null);
    let cv;
    try {
      cv = await loadOpenCV();
    } catch (e) {
      if (placeRunRef.current !== run) return;
      setPlaceFailure(`OpenCV.js could not load (${(e as Error).message}) — place the ROI by tapping corners.`);
      setPlaceStage("tapping");
      setTaps([]);
      return;
    }
    const res = await runPlacement({
      cv,
      model: fieldModel,
      grabFrame: grabFrameAt,
      startTime: fromTime,
      duration: v.duration,
      onProgress: (p) => {
        if (placeRunRef.current === run) setPlaceProgress(p);
      },
      isCancelled: () => placeRunRef.current !== run,
    });
    if (placeRunRef.current !== run) return;
    await seekTo(v, resumeAt);
    if (res.locked) {
      const L = res.locked;
      applyRois(L.rois);
      lockTimeRef.current = L.lockTime;
      lockedRef.current = { placement: L.representative, method: L.method };
      setPlacementCam({ pose: L.representative.solution.pose, intrinsics: L.representative.solution.intrinsics });
      setPlaceSummary(summaryOf(L));
      setOverlayDebug(debugOf(L.representative, L.method, L.reprojError));
      setPlaceStage("proposed");
      logPlacement(L.method, L);
    } else {
      // A and B both failed -> straight to the guided 4-tap flow.
      setPlaceFailure(res.failureSummary ?? "no usable frames");
      setOverlayDebug({ method: "—", reprojError: null, fovDeg: null, pose: null, intrinsics: null, tags: res.lastTags, fieldPlane: res.lastFieldPlaneDebug });
      setPlaceStage("tapping");
      setTaps([]);
      logPlacement("none", null, res.failureSummary);
    }
  }
  const startPlacementRef = useRef(startPlacement);
  useEffect(() => {
    startPlacementRef.current = startPlacement;
  });

  async function handleTap(nx: number, ny: number) {
    const v = videoRef.current;
    if (!v || !taps || !fieldModel) return;
    const next = [...taps, [nx * v.videoWidth, ny * v.videoHeight] as Vec2];
    setTaps(next);
    if (next.length < 4) return;
    try {
      const cv = await loadOpenCV();
      const r = placeFromTaps(cv, next, { width: v.videoWidth, height: v.videoHeight }, fieldModel, DEFAULT_PLACEMENT_CONFIG, v.currentTime);
      if (!r.placement) {
        setPlaceFailure(`4-tap placement failed: ${r.reason}. Tap the corners again.`);
        setTaps([]);
        return;
      }
      const L = aggregatePlacements([r.placement], DEFAULT_PLACEMENT_CONFIG, 1)!;
      applyRois(L.rois);
      lockTimeRef.current = v.currentTime;
      lockedRef.current = { placement: r.placement, method: "C" };
      setPlacementCam({ pose: r.placement.solution.pose, intrinsics: r.placement.solution.intrinsics });
      resetScorer();
      setPlaceSummary(summaryOf(L));
      setOverlayDebug(debugOf(r.placement, "C", L.reprojError));
      setTaps(null);
      setPlaceStage("proposed");
      logPlacement("C", L);
    } catch (e) {
      setPlaceFailure(`4-tap placement failed: ${(e as Error).message}`);
      setTaps([]);
    }
  }

  // Remember the lock frame's features so a moved camera can be detected later.
  async function armMotionMonitor(refTime: number) {
    const v = videoRef.current;
    if (!v) return;
    try {
      const cv = await loadOpenCV();
      const resume = v.currentTime;
      const frame = await grabFrameAt(refTime);
      await seekTo(v, resume);
      if (!frame) return;
      motionRef.current?.dispose();
      motionRef.current = new CameraMotionMonitor(cv, frame);
    } catch (e) {
      console.warn("camera-motion monitor unavailable", e);
    }
  }

  function confirmPlacement() {
    setPlaceStage("confirmed");
    const s = placeSummary;
    pushLog(`[ROI] confirmed (${s ? (s.nudged ? `D, nudged from ${s.method}` : s.method) : "D"})`);
    void armMotionMonitor(lockTimeRef.current);
  }

  // Manual placement (method D): any drag / resize / slider change overrides the
  // automatic result for this session.
  function manualZone(alliance: AllianceColor, z: Zone) {
    if (alliance === "red") {
      setRedZone(z);
      setRedEnabled(true);
    } else {
      setBlueZone(z);
      setBlueEnabled(true);
    }
    setPlaceSummary((s) => (s ? { ...s, nudged: true } : s));
    if (placeStage !== "proposed" && placeStage !== "confirmed") setPlaceStage("unplaced");
    resetScorer();
  }

  // Persist the confirmed ROI(s) (and any later manual override) for this video so
  // reopening it restores them instantly.
  useEffect(() => {
    if (placeStage !== "confirmed" || !fileKeyRef.current) return;
    const lp = lockedRef.current;
    const method: MethodId = placeSummary?.nudged || !lp ? (placeSummary && !placeSummary.nudged ? placeSummary.method : "D") : lp.method;
    const quadFor = (a: AllianceColor) => overlayRois.find((r) => r.alliance === a)?.quad ?? null;
    const saved: SavedPlacement = {
      version: 1,
      savedAt: new Date().toISOString(),
      videoKey: fileKeyRef.current,
      method,
      fovDeg: placeSummary?.fovDeg ?? lp?.placement?.solution.intrinsics.fovDeg ?? null,
      poseFovDeg: lp?.placement?.solution.intrinsics.fovDeg ?? null,
      k1: lp?.placement?.solution.intrinsics.k1 ?? null,
      fovRefined: placeSummary?.fovRefined,
      fovWellConstrained: placeSummary?.fovWellConstrained,
      reprojError: placeSummary?.reprojError ?? null,
      pose: lp?.placement?.solution.pose ?? null,
      lockTime: lockTimeRef.current,
      rois: [
        { alliance: "red", quad: quadFor("red"), zone: redZone, direction: redDir, enabled: redEnabled },
        { alliance: "blue", quad: quadFor("blue"), zone: blueZone, direction: blueDir, enabled: blueEnabled },
      ],
    };
    savePlacement(saved);
  }, [placeStage, placeSummary, overlayRois, redZone, blueZone, redDir, blueDir, redEnabled, blueEnabled]);

  // When a video's metadata is ready: restore a saved placement instantly, or run
  // automatic placement.
  useEffect(() => {
    const key = fileKeyRef.current;
    if (!videoUrl || !meta.width || !key || autoPlacedForRef.current === key) return;
    autoPlacedForRef.current = key;
    const saved = loadPlacement(key);
    if (saved) {
      const rois = saved.rois.filter((r) => r.enabled);
      applyRois(rois.map((r) => ({ alliance: r.alliance, quad: r.quad, zone: r.zone, direction: r.direction })));
      lockTimeRef.current = saved.lockTime;
      lockedRef.current = null;
      const camFov = saved.poseFovDeg ?? saved.fovDeg;
      setPlacementCam(saved.pose && camFov ? { pose: saved.pose, intrinsics: { ...intrinsicsFromFov(meta.width, meta.height, camFov), k1: saved.k1 ?? undefined } } : null);
      setPlaceSummary({
        method: saved.method,
        reprojError: saved.reprojError,
        fovDeg: saved.fovDeg,
        fovRefined: saved.fovRefined ?? false,
        fovWellConstrained: saved.fovWellConstrained ?? false,
        framesUsed: 0,
        framesTried: 0,
        confidence: "high",
        notes: [],
        alliances: rois.map((r) => r.alliance),
        nudged: false,
        restored: true,
      });
      setPlaceStage("confirmed");
      pushLog(`[ROI] restored saved placement (method ${saved.method}, saved ${saved.savedAt})`);
      void armMotionMonitor(saved.lockTime);
      return;
    }
    void startPlacementRef.current(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, meta.width]);


  useEffect(() => () => motionRef.current?.dispose(), []);

  const latestEvent = useMemo(() => {
    const accepted = events
      .filter((e) => e.status !== "rejected" && e.videoTime <= currentTime)
      .sort((a, b) => b.videoTime - a.videoTime)[0];
    return accepted ? `${accepted.alliance.toUpperCase()} +${accepted.points} @ ${fmt(accepted.videoTime)}` : null;
  }, [events, currentTime]);

  // Sample a gate crop from the ACTUAL video frame (normalized zone coords ×
  // video.videoWidth/Height — never the displayed/CSS size). Returns the raw crop
  // pixels; candidate detection is run by the caller. Reads colour/sensitivity
  // from refs so it stays stable across renders.
  const sampleZone = useCallback(
    (video: HTMLVideoElement, zone: Zone): { data: Uint8ClampedArray | null; w: number; h: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { data: null, w: 0, h: 0 };
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!ctx || !vw || !vh) return { data: null, w: 0, h: 0 };
      const sw = Math.max(2, Math.round(zone.w * vw));
      const sh = Math.max(2, Math.round(zone.h * vh));
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(video, zone.x * vw, zone.y * vh, zone.w * vw, zone.h * vh, 0, 0, sw, sh);
      const data = ctx.getImageData(0, 0, sw, sh).data;
      return { data, w: sw, h: sh };
    },
    [],
  );

  const paintMask = useCallback((mask: HTMLCanvasElement | null, data: Uint8ClampedArray | null, w: number, h: number, sensitivity: number, floors: { minSat: number; minVal: number }) => {
    if (!mask || !data || w === 0 || h === 0) return;
    const m = computeMaskImage(data, w, h, candidateCfgFrom(colorTargetsRef.current, sensitivity, floors));
    mask.width = w;
    mask.height = h;
    const c = mask.getContext("2d");
    if (c) {
      const img = c.createImageData(w, h);
      img.data.set(m);
      c.putImageData(img, 0, 0);
    }
  }, []);

  function pushLog(line: string) {
    const d = diagRef.current;
    d.log.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (d.log.length > 300) d.log.shift();
  }

  // Append CV crossing events. `scoredUpTo` already prevents replay double-counts,
  // so distinct simultaneous artifacts (different trackId) all pass through; a tiny
  // guard blocks only an exact same-frame double from the dual driver.
  const addLiveEvents = useCallback((alliance: AllianceColor, t: number, crossings: CrossingEvent[]) => {
    if (crossings.length === 0) return;
    setEvents((prev) => {
      const next = [...prev];
      for (const c of crossings) {
        const dup = next.some(
          (e) =>
            e.alliance === alliance &&
            e.method === "cv" &&
            e.trackId === c.trackId &&
            Math.abs(e.videoTime - t) < 0.4,
        );
        if (dup) continue;
        const n = Math.max(1, c.estimatedCount);
        next.push({
          id: nextId(),
          videoTime: t,
          alliance,
          type: "classified",
          color: c.color === "unknown" ? "unknown" : c.color,
          points: artifactPointsFor("classified") * n,
          method: "cv",
          status: "auto",
          confidence: c.confidence,
          source: "gate_detection",
          zoneX: c.centerX,
          trackId: c.trackId,
          count: n,
          note: n > 1 ? `Clump ×${n} (area estimate) — review` : undefined,
        });
      }
      return next;
    });
  }, []);

  // ---- RAMP queue counter ------------------------------------------------------
  const scoringWindow = scoringWindowOf(matchStart, matchEnd, autoWindow, barWindow);
  // RAMPS too small in the picture for the v2 count to be relied on: px between ARTIFACTS, by alliance
  const smallRamps = new Map(rampAuto.filter((a) => a.slotPitchPx > 0 && a.slotPitchPx < MIN_RELIABLE_ARTIFACT_PX).map((a) => [a.alliance, a.slotPitchPx]));
  // RAMPS placement did not find in the picture: their alliance's ARTIFACTS are not counted
  const missingRamps = (["red", "blue"] as const).filter((a) => !(a === "red" ? redEnabled : blueEnabled));
  const rampEngine = !forceLegacy && placementCam != null && !placeSummary?.nudged;
  const rampEngineRef = useRef(rampEngine);
  useEffect(() => { rampEngineRef.current = rampEngine; }, [rampEngine]);

  // Camera-moved check while the video plays: a consistent shift of most tracked
  // features (not a robot covering a few) unlocks the ROI and re-runs placement.
  // Only for the legacy gate engine, whose boxes are fixed in the image. The RAMP counter
  // follows the camera itself (a tracker per RAMP, re-anchored to the lock frame, plus a
  // whole-view fallback), and this check judged a normal match as a "camera cut" within
  // seconds (robots and people move away from the lock frame's features), which stopped live
  // counting, re-ran placement and threw the count away.
  useEffect(() => {
    if (placeStage !== "confirmed" || rampEngine) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      const mon = motionRef.current;
      if (!v || !mon || v.paused || v.seeking || v.ended) return;
      const fr = grabCurrentFrame();
      if (!fr) return;
      const res = mon.check(fr);
      if (res.moved) {
        pushLog(`[ROI] camera moved (${res.reason}) — counting paused, re-finding the field`);
        v.pause();
        setLiveOn(false);
        void startPlacementRef.current(v.currentTime, true);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [placeStage, rampEngine]);

  function resetScorer() {
    scorerRef.current?.dispose();
    scorerRef.current = null;
    v2Ref.current?.reset();
    counterSizeRef.current = null;
    setRampAuto([]);
    setRampResults([]);
    setLaneViews([]);
    autoWindowRef.current = null;
    setAutoWindow(null);
    barRef.current.reset();
    barReadAtRef.current = -Infinity;
    barWindowRef.current = null;
    setBarWindow(null);
    setBarCounts(null);
    setBarSettledAt(null);
    setVisionCounts(null);
  }

  // Read the broadcast's score bar in the current frame (full resolution), twice a second of video.
  function readBarAt(t: number) {
    if (t >= barReadAtRef.current && t - barReadAtRef.current < 0.5) return;
    barReadAtRef.current = t;
    const f = grabCurrentFrame(null);
    barRef.current.push(t, f ? readScoreBar(f, BAR_DIGITS) : null);
  }

  // The counter follows the camera from the frame the pose was found in (the lock frame).
  // Seeks there and back, so call it only while paused.
  async function ensureScorer(): Promise<RampScorer | null> {
    if (scorerRef.current) return scorerRef.current;
    const v = videoRef.current;
    const alliances = [...(redEnabledRef.current ? ["red" as const] : []), ...(blueEnabledRef.current ? ["blue" as const] : [])];
    const cam = placementCamRef.current;
    if (!v || !cam || !fieldModel || !alliances.length) return null;
    const cv = await loadOpenCV();
    // one working scale for every resolution (see counterScale)
    const native = { width: v.videoWidth, height: v.videoHeight };
    const scale = counterScale(fieldModel, cam, native, alliances);
    const size = { width: Math.round(native.width * scale), height: Math.round(native.height * scale) };
    const back = v.currentTime;
    const ref = await grabFrameAt(lockTimeRef.current, size);
    await seekTo(v, back);
    if (!ref) return null;
    counterSizeRef.current = size;
    scorerRef.current = new RampScorer(cv, fieldModel, resizedCamera(cam, size.width, size.height), ref, alliances, { matchStart: matchStartRef.current });
    // the v2 counter's networks (ONNX Runtime Web): ready before the first frame is counted
    if (!v2Ref.current) {
      setV2State("loading");
      try {
        v2Ref.current = new RampCounterV2(await loadRampModels());
        // development only: the v2 counter, for inspecting it from the browser console
        if (process.env.NODE_ENV === "development") (window as unknown as { __v2?: RampCounterV2 }).__v2 = v2Ref.current;
        setV2State("ready");
        pushLog("[RAMP] v2 counter ready (strip detector + entry counter)");
      } catch (e) {
        setV2State("failed");
        pushLog(`[RAMP] v2 counter could not load (${e instanceof Error ? e.message : String(e)}) — counting with the v1 queue counter`);
      }
    }
    // development only: the live counter, for inspecting it from the browser console
    if (process.env.NODE_ENV === "development") (window as unknown as { __rampScorer?: RampScorer }).__rampScorer = scorerRef.current;
    pushLog(`[RAMP] counter started (reference frame ${lockTimeRef.current.toFixed(2)}s, match start ${matchStartRef.current.toFixed(2)}s, working frames ${size.width}×${size.height} of ${native.width}×${native.height})`);
    return scorerRef.current;
  }

  // The last frames detected and counted (the v2 counter works a little behind the video), then
  // the result published.
  async function finishCount(scorer: RampScorer) {
    try {
      await v2Ref.current?.flush();
    } catch (e) {
      pushLog(`[RAMP] v2 counter failed at the end: ${e instanceof Error ? e.message : String(e)}`);
    }
    applyRamp(scorer);
  }

  // Re-count from everything seen so far and publish it: events (keeping reviewer edits),
  // the debug view and the per-RAMP automatic values.
  const applyRamp = useCallback((scorer: RampScorer) => {
    const duration = videoRef.current?.duration;
    const auto = duration ? scorer.matchWindow(duration) : null;
    if (!sameWindow(auto, autoWindowRef.current)) {
      autoWindowRef.current = auto;
      setAutoWindow(auto);
    }
    const bar = barRef.current;
    const bw = bar.present ? bar.window() : null;
    if (!sameBarWindow(bw, barWindowRef.current)) {
      barWindowRef.current = bw;
      setBarWindow(bw);
    }
    const w = scoringWindowOf(matchStartRef.current, matchEndRef.current, auto, bw);
    // Once the match start is known (set by hand, read from the score bar's clock, or found from
    // the field) the counter
    // calibrates there — on the pre-staged ARTIFACTS just before it and the empty RAMP — exactly
    // as when it is given the start up front, and counts everything seen again with that.
    // (found from the field without seeing AUTO begin: the start lies between the earliest it can
    // have been, for a 15 s transition, and the latest, for an 8 s one; the counter calibrates
    // closest to the earliest — before the match either way — and counts from it)
    const calStart = matchStartRef.current > 0 ? matchStartRef.current : bw ? bw.start : auto?.final ? auto.start : null;
    const latest = matchStartRef.current > 0 ? matchStartRef.current : bw ? bw.start : auto?.final ? auto.likelyStart : null;
    if (calStart != null && latest != null && scorer.calibrateAt(calStart, calStart, latest)) pushLog(`[RAMP] calibrated at the match start ${calStart.toFixed(2)}s (${matchStartRef.current > 0 ? "set by hand" : "found from the field"}) — recounted`);
    const results = scorer.results();
    const autoParams = scorer.autoParams();
    const until = w.buzzer != null ? w.buzzer + SETTLE_SEC : Infinity;
    // the v2 counter (ARTIFACTS coming onto each RAMP) when its networks run; else the v1 queue counter.
    // A RAMP too small in the picture to count reliably (rampCounterV2.ts) is not scored, as one
    // out of the picture is not: its count was off by 25 % to 1000 %, either way.
    const tooSmall = new Set(autoParams.filter((a) => a.slotPitchPx > 0 && a.slotPitchPx < MIN_RELIABLE_ARTIFACT_PX).map((a) => a.alliance));
    const v2 = v2Ref.current;
    const fresh = v2
      ? v2Events(v2, results.map((r) => r.alliance).filter((a) => !tooSmall.has(a)), w.start, until)
      : rampEvents(results).filter((e) => e.videoTime >= w.start - 1e-6 && e.videoTime <= until + 1e-6);
    if (v2) {
      const upTo = Math.min(until, videoRef.current?.currentTime ?? until);
      setV2Seen(results.map((r) => ({
        alliance: r.alliance,
        share: upTo > w.start ? v2.seenShare(r.alliance, w.start, upTo) : 0,
        unscored: tooSmall.has(r.alliance) ? v2.count(r.alliance, w.start, upTo) : null,
      })));
    }
    // With the broadcast's score bar in the video its official counts are what is scored; the
    // RAMP counter's own count is kept beside them as a check. Without it, the RAMP counter scores.
    // the bar's counts (when legible: a small bar can show a readable clock and unreadable
    // counts): everything accepted so far, up to where they settled after the buzzer
    const barScores = bar.countsReadable;
    const barUntil = barScores ? (bar.settledAt() ?? Infinity) : until;
    const scored = barScores ? scoreBarEvents(bar, barUntil) : fresh;
    const source = barScores ? "scoreboard" : "ramp_queue";
    setEvents((prev) => {
      const old = new Map(prev.filter((e) => e.source === source).map((e) => [e.id, e]));
      const merged = scored.map((e) => {
        const o = old.get(e.id);
        return o && o.status !== "auto" ? { ...e, status: o.status, type: o.type, points: o.points, color: o.color } : e;
      });
      return [...prev.filter((e) => e.source !== "ramp_queue" && e.source !== "scoreboard"), ...merged];
    });
    setBarCounts(barScores ? bar.countsAt(Math.min(barUntil, bar.lastT)) : null);
    setBarSettledAt(barScores ? bar.settledAt() : null);
    setVisionCounts(barScores ? { red: fresh.filter((e) => e.alliance === "red").length, blue: fresh.filter((e) => e.alliance === "blue").length } : null);
    setRampResults(results);
    setRampAuto(autoParams);
    const d = diagRef.current;
    // the status line shows what the scoreboard scores: ARTIFACTS inside the window
    for (const r of results) {
      const g = r.alliance === "red" ? d.red : d.blue;
      g.totalCrossings = fresh.filter((e) => e.alliance === r.alliance).length;
    }
  }, []);

  // Live detection loop. Dual driver (requestVideoFrameCallback + a 33 ms interval
  // watchdog) so it runs at any playback speed and even where rVFC never fires;
  // both feed one media-time-deduped processFrame. Detects EVERY candidate in each
  // gate crop and lets each cross independently (no global gate lock).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !liveOn || rampEngine) return;
    const rvfc = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const supported = typeof rvfc.requestVideoFrameCallback === "function";

    const redTracker = new GateMultiTracker(trackerCfgFrom(redZone, redDir, redSingleRef.current, DEFAULT_RED_MAX_CLUMP));
    const blueTracker = new GateMultiTracker(trackerCfgFrom(blueZone, blueDir, blueSingleRef.current, DEFAULT_BLUE_MAX_CLUMP));
    lastMediaTimeRef.current = -1;
    scoredUpToRef.current = v.currentTime - 0.05; // only score footage ahead of here
    diagRef.current.status = "Detector running";
    diagRef.current.red.detector = "running";
    diagRef.current.blue.detector = "running";

    let handle = 0;
    let stopped = false;

    const processFrame = (mediaTime: number) => {
      const redCfg = candidateCfgFrom(colorTargetsRef.current, redSensRef.current, RED_COLOR_FLOORS);
      const blueCfg = candidateCfgFrom(colorTargetsRef.current, blueSensRef.current);
      // Buzzer: at match end, stop scoring, pause playback, and show results (once).
      const mEnd = matchEndRef.current;
      if (mEnd != null && mediaTime >= mEnd) {
        if (!v.paused) v.pause();
        if (!matchEndedRef.current) {
          matchEndedRef.current = true;
          setMatchComplete(true);
          diagRef.current.status = `Match complete — scoring stopped @ ${fmtCs(mEnd)}`;
          pushLog(`[MATCH] buzzer at ${mEnd.toFixed(2)}s — scoring stopped`);
        }
        return;
      }
      // Only footage inside the scoring window (>= match start, before the buzzer) counts.
      const inWindow = mediaTime >= matchStartRef.current - 1e-3;
      const newTerritory = mediaTime > scoredUpToRef.current + 1e-3;
      if (newTerritory) scoredUpToRef.current = mediaTime;

      const rs = redEnabledRef.current ? sampleZone(v, redZone) : { data: null, w: 0, h: 0 };
      const bs = blueEnabledRef.current ? sampleZone(v, blueZone) : { data: null, w: 0, h: 0 };
      const redCands = rs.data ? detectCandidates(rs.data, rs.w, rs.h, redCfg) : [];
      const blueCands = bs.data ? detectCandidates(bs.data, bs.w, bs.h, blueCfg) : [];
      const rU = redTracker.update(redCands);
      const bU = blueTracker.update(blueCands);

      const d = diagRef.current;
      d.framesAnalyzed++;
      d.lastProcessedTime = mediaTime;

      const applyGate = (
        gate: GateDiag,
        cands: Candidate[],
        crossings: CrossingEvent[],
        alliance: AllianceColor,
      ) => {
        gate.detector = "running";
        gate.candidates = cands.length;
        gate.present = cands.length > 0;
        gate.crossingThisFrame = crossings.length;
        if (crossings.length && newTerritory && inWindow) {
          gate.totalCrossings += crossings.length;
          gate.lastEvent = `+${3 * crossings.length} @ ${fmtCs(mediaTime)}`;
          gate.flashWall = Date.now();
          d.status = `${alliance.toUpperCase()} +${3 * crossings.length} @ ${fmtCs(mediaTime)}`;
          for (const c of crossings) {
            pushLog(`[SCORE] ${alliance.toUpperCase()} +3 track#${c.trackId} x=${c.centerX.toFixed(2)} @ ${mediaTime.toFixed(3)}${c.uncertain ? ` (multi?×${c.estimatedCount})` : ""}`);
          }
          addLiveEvents(alliance, mediaTime, crossings);
        }
      };
      applyGate(d.red, redCands, rU.crossings, "red");
      applyGate(d.blue, blueCands, bU.crossings, "blue");

      if (!rU.crossings.length && !bU.crossings.length) {
        d.status = redCands.length || blueCands.length
          ? `Tracking ${redCands.length + blueCands.length} candidate(s)`
          : "Detector running — no artifacts in gates";
      }

      if (debugModeRef.current) {
        const now = Date.now();
        drawCropWithOverlay(redCropRef.current, rs.data, rs.w, rs.h, redCands, redZone.line, redDir, now - d.red.flashWall < 700);
        drawCropWithOverlay(blueCropRef.current, bs.data, bs.w, bs.h, blueCands, blueZone.line, blueDir, now - d.blue.flashWall < 700);
        paintMask(redMaskRef.current, rs.data, rs.w, rs.h, redSensRef.current, RED_COLOR_FLOORS);
        paintMask(blueMaskRef.current, bs.data, bs.w, bs.h, blueSensRef.current, BLUE_COLOR_FLOORS);
      }
    };

    const onSeeking = () => {
      redTracker.reset();
      blueTracker.reset();
      lastMediaTimeRef.current = -1;
      // Seeking back before the buzzer re-arms the auto-stop and hides results.
      const mEnd = matchEndRef.current;
      if (mEnd == null || v.currentTime < mEnd - 0.1) {
        matchEndedRef.current = false;
        setMatchComplete(false);
      }
    };
    v.addEventListener("seeking", onSeeking);

    const EPS = 0.003;
    const processAtTime = (mt: number) => {
      if (stopped) return;
      if (Math.abs(mt - lastMediaTimeRef.current) < EPS) return;
      lastMediaTimeRef.current = mt;
      processFrame(mt);
    };

    if (supported) {
      const onFrame = (_now: number, md: { mediaTime: number }) => {
        if (stopped) return;
        processAtTime(md?.mediaTime ?? v.currentTime);
        handle = rvfc.requestVideoFrameCallback!(onFrame);
      };
      handle = rvfc.requestVideoFrameCallback!(onFrame);
    }

    const interval = window.setInterval(() => {
      if (stopped) return;
      if (!v.paused && !v.ended && v.readyState >= 2) processAtTime(v.currentTime);
    }, 33);

    return () => {
      stopped = true;
      if (handle && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(handle);
      window.clearInterval(interval);
      v.removeEventListener("seeking", onSeeking);
      diagRef.current.red.detector = "inactive";
      diagRef.current.blue.detector = "inactive";
    };
  }, [liveOn, rampEngine, sampleZone, paintMask, addLiveEvents, redZone, blueZone, redDir, blueDir]);

  // Live counting needs every frame while the match plays. A browser stops delivering video
  // frames (and throttles timers) to a page in the background, but the video keeps playing:
  // the counter would silently miss the rest of the match. So while live is on, a hidden page
  // pauses the video (also when playback starts while hidden, e.g. from a media key), and it
  // resumes when the page is visible again.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !liveOn) return;
    let pausedByUs = false;
    const onPlay = () => {
      if (document.visibilityState === "hidden") onVisibility();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!v.paused && !v.ended) {
          v.pause();
          pausedByUs = true;
          diagRef.current.status = "Live paused — the page is in the background. It resumes when you come back.";
          pushLog(`[LIVE] paused at ${v.currentTime.toFixed(2)}s: the page went to the background (live counting needs it visible)`);
        }
      } else if (pausedByUs) {
        pausedByUs = false;
        pushLog(`[LIVE] page visible again — resuming at ${v.currentTime.toFixed(2)}s`);
        void v.play().catch(() => pushLog("[LIVE] press play to resume"));
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    v.addEventListener("play", onPlay);
    if (document.visibilityState === "hidden") onVisibility();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      v.removeEventListener("play", onPlay);
    };
  }, [liveOn]);

  // Live RAMP counting: every played frame (at RAMP_FPS) goes to the counter; the count is
  // re-decoded about once a second (provisional) and once more when live stops.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !liveOn || !rampEngine) return;
    const rvfc = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    let stopped = false;
    let scorer: RampScorer | null = null;
    let handle = 0;
    let lastBin = -1;
    let lastDecode = 0;
    // The provisional re-count runs on the main thread: at most every second, and less often
    // when it is slow on this device, so it never takes more than ~10% of the time.
    let decodeEvery = 1000;
    let lastLanes = 0;
    // frames counted in the last second of playback, shown so a slow device is visible
    const recent: number[] = [];
    // Every frame must be counted: a frame not counted is a frame the RAMP was not seen. A device
    // that cannot count RAMP_FPS frames per second of video in real time plays the video slower
    // instead, at the rate where it keeps up (judged on the share of frames counted lately).
    let rate = 1;
    let keptUp = 0; // rate checks in a row that counted every frame
    let lastRateCheck = 0;
    let busyMs = 0; // time spent counting frames since the last rate check (the headroom left)
    let frameDt = Infinity; // the video's own frame interval: the smallest step between presented frames
    let lastPresented: number | null = null;
    const countedBins: number[] = []; // frames (at RAMP_FPS) counted in the last LIVE_RATE_SPAN_SEC of video
    // A browser can also stop giving the page frames and timers without hiding it (an occluded
    // window, a throttled embedded view) while the video plays on. Playback that passes with no
    // frame counted would be lost silently, so a gap of more than LIVE_STALL_SEC between counted
    // frames is not counted across: the video goes back to the last counted frame and plays on
    // from there a moment later.
    let lastCounted: number | null = null; // media time of the last counted frame (null after a seek)
    let resumeTimer = 0;
    const d = diagRef.current;
    d.status = "Starting the RAMP counter…";
    d.red.detector = d.blue.detector = "running";

    const processAt = (mediaTime: number) => {
      if (stopped || !scorer) return;
      const w = scoringWindowOf(matchStartRef.current, matchEndRef.current, autoWindowRef.current, barWindowRef.current);
      const stopAt = scoringEndOf(w, barRef.current);
      // checked before the buzzer, so frames held back just before it are played again too
      if (!matchEndedRef.current && lastCounted != null && mediaTime - lastCounted > LIVE_STALL_SEC && !v.paused && (stopAt == null || lastCounted < stopAt)) {
        const back = lastCounted;
        v.pause();
        v.currentTime = back;
        d.status = `Live caught up — the browser stopped giving this page frames for ${(mediaTime - back).toFixed(1)} s, so that part is played again. Keep the page in view while live counting.`;
        pushLog(`[LIVE] no frame counted between ${back.toFixed(2)}s and ${mediaTime.toFixed(2)}s (the browser held back frames) — going back to ${back.toFixed(2)}s`);
        window.clearTimeout(resumeTimer);
        resumeTimer = window.setTimeout(() => {
          if (!stopped) void v.play().catch(() => pushLog("[LIVE] press play to resume"));
        }, 300);
        return;
      }
      // At the end of scoring the video pauses once to show the result; played on after that
      // (to review the field) nothing more is counted.
      if (stopAt != null && w.buzzer != null && mediaTime >= stopAt) {
        if (!matchEndedRef.current) {
          if (!v.paused) v.pause();
          rate = v.playbackRate = 1; // played on after the result: nothing more is counted
          matchEndedRef.current = true;
          const buzzer = w.buzzer, source = w.source, barScored = w.source === "scoreboard" && barRef.current.countsReadable;
          d.status = "Buzzer — finishing the count…";
          // the result is shown once the last frames are counted, so it never changes after
          void finishCount(scorer).then(() => {
            setMatchComplete(true);
            d.status = barScored
              ? `Match complete — buzzer @ ${fmtCs(buzzer)} (${windowSourceText(source)}); the scorekeepers' entries on the score bar counted until they settled @ ${fmtCs(stopAt)}`
              : `Match complete — buzzer @ ${fmtCs(buzzer)} (${windowSourceText(source)}); ARTIFACTS still in the air counted until ${fmtCs(stopAt)}`;
            pushLog(`[MATCH] buzzer at ${buzzer.toFixed(2)}s (${source}) — scoring stopped at ${stopAt.toFixed(2)}s`);
          });
        }
        return;
      }
      const bin = Math.round(mediaTime * RAMP_FPS);
      if (bin === lastBin) return;
      lastBin = bin;
      const started = performance.now();
      const f = grabCurrentFrame(counterSizeRef.current);
      if (!f) return;
      scorer.push(f, mediaTime);
      const v2 = v2Ref.current;
      if (v2) {
        for (const s of scorer.strips(f)) v2.add(s.alliance, mediaTime, s.strip);
        if (v2.pendingStrips >= 8) void v2.flush(false);
      }
      readBarAt(mediaTime);
      const afterBuzzer = w.source === "scoreboard" && barRef.current.countsReadable && w.buzzer != null && mediaTime >= w.buzzer;
      lastCounted = mediaTime;
      d.framesAnalyzed++;
      d.lastProcessedTime = mediaTime;
      const now = performance.now();
      recent.push(now);
      while (recent.length && now - recent[0] > 1000) recent.shift();
      countedBins.push(bin);
      while (countedBins.length && countedBins[0] < bin - LIVE_RATE_SPAN_SEC * RAMP_FPS) countedBins.shift();
      busyMs += now - started;
      if (now - lastRateCheck > 1000) {
        // the share of the page's time spent counting frames: below LIVE_TARGET_LOAD there is room
        // to play faster, by as much as that room allows
        const load = lastRateCheck > 0 ? busyMs / (now - lastRateCheck) : 1;
        busyMs = 0;
        lastRateCheck = now;
        const span = (bin - countedBins[0]) / RAMP_FPS; // seconds of video
        if (span >= 1) {
          const perSec = Number.isFinite(frameDt) ? Math.min(RAMP_FPS, 1 / frameDt) : RAMP_FPS;
          const share = Math.min(1, countedBins.length / (1 + span * perSec));
          if (share < 0.95) {
            rate = Math.max(LIVE_MIN_RATE, rate * share * 0.95);
            keptUp = 0;
            countedBins.length = 0; // the new rate is judged on its own frames
          } else if (rate < 1 && load < 0.8 * LIVE_TARGET_LOAD && ++keptUp >= 2) {
            rate = Math.min(1, rate * Math.min(1.25, LIVE_TARGET_LOAD / Math.max(load, 0.05)));
            keptUp = 0;
            countedBins.length = 0;
          }
          if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
        }
      }
      d.status = afterBuzzer
        ? `Buzzer @ ${fmtCs(w.buzzer!)} — reading the scorekeepers' last entries on the score bar`
        : scorer.phase === "finding-staged"
          ? "Calibrating — looking for the pre-staged ARTIFACTS at match start"
          : `Counting RAMP queues (calibrated @ ${fmt(scorer.calibrationTime ?? 0)}) · ${recent.length} frames/s${rate < 0.999 ? ` · playing at ${rate.toFixed(2)}× so that every frame is counted (this device cannot count in real time)` : ""}`;
      if (debugModeRef.current && now - lastLanes > 200) {
        lastLanes = now;
        setLaneViews(scaleLaneViews(scorer.laneViews(), (videoRef.current?.videoWidth ?? 1) / (counterSizeRef.current?.width ?? videoRef.current?.videoWidth ?? 1)));
      }
      if (now - lastDecode > decodeEvery) {
        lastDecode = now;
        if (v2) void v2.flush();
        applyRamp(scorer);
        decodeEvery = Math.max(1000, 10 * (performance.now() - now));
      }
    };

    void (async () => {
      const wasPlaying = !v.paused;
      v.pause();
      const s = await ensureScorer();
      if (stopped) return;
      if (!s) {
        pushLog("[RAMP] counter could not start (no camera pose or no RAMP in view)");
        setLiveOn(false);
        return;
      }
      scorer = s;
      d.status = "RAMP counter ready";
      if (wasPlaying) void v.play();
      if (typeof rvfc.requestVideoFrameCallback === "function") {
        const onFrame = (_now: number, md: { mediaTime: number }) => {
          if (stopped) return;
          const mt = md?.mediaTime ?? v.currentTime;
          if (lastPresented != null && mt > lastPresented) frameDt = Math.min(frameDt, mt - lastPresented);
          lastPresented = mt;
          processAt(mt);
          handle = rvfc.requestVideoFrameCallback!(onFrame);
        };
        handle = rvfc.requestVideoFrameCallback(onFrame);
      }
    })();
    const interval = window.setInterval(() => {
      if (!v.paused && !v.ended && v.readyState >= 2) processAt(v.currentTime);
    }, 33);
    const onSeeking = () => {
      const w = scoringWindowOf(matchStartRef.current, matchEndRef.current, autoWindowRef.current, barWindowRef.current);
      const end = scoringEndOf(w, barRef.current);
      if (end == null || v.currentTime < end - 0.1) {
        matchEndedRef.current = false;
        setMatchComplete(false);
      }
      // a seek (by the user, or back after a stall) starts counting afresh from there
      if (lastCounted == null || Math.abs(v.currentTime - lastCounted) > 1e-3) lastCounted = null;
      lastPresented = null;
      countedBins.length = 0;
    };
    v.addEventListener("seeking", onSeeking);
    // The video ends before scoring was over (it stops at the buzzer, or with the score bar still
    // up): the match is over at the end of the video.
    const onEnded = () => {
      const w = scoringWindowOf(matchStartRef.current, matchEndRef.current, autoWindowRef.current, barWindowRef.current);
      if (stopped || !scorer || matchEndedRef.current || w.buzzer == null) return;
      matchEndedRef.current = true;
      const buzzer = w.buzzer, source = w.source;
      void finishCount(scorer).then(() => {
        setMatchComplete(true);
        d.status = `Match complete — buzzer @ ${fmtCs(buzzer)} (${windowSourceText(source)}); the video ends @ ${fmtCs(v.duration)}`;
        pushLog(`[MATCH] the video ends at ${v.duration.toFixed(2)}s, before scoring was over — counted to there`);
      });
    };
    v.addEventListener("ended", onEnded);
    return () => {
      stopped = true;
      if (handle && rvfc.cancelVideoFrameCallback) rvfc.cancelVideoFrameCallback(handle);
      window.clearInterval(interval);
      window.clearTimeout(resumeTimer);
      v.removeEventListener("seeking", onSeeking);
      v.removeEventListener("ended", onEnded);
      v.playbackRate = 1;
      if (scorer) applyRamp(scorer);
      d.red.detector = d.blue.detector = "inactive";
    };
    // ensureScorer reads the current placement; the scorer is reset whenever that changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOn, rampEngine, applyRamp]);

  // A new match start re-calibrates the counter (it looks for the staged ARTIFACTS there).
  useEffect(() => {
    if (!liveOnRef.current && processingRef.current !== "analyzing") resetScorer();
  }, [matchStart, redEnabled, blueEnabled]);

  useEffect(() => () => scorerRef.current?.dispose(), []);

  // Offline pass: seek frame-by-frame across the whole video and score crossings.
  const runAnalysis = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    cancelRef.current = false;
    setProcessing("analyzing");
    setProgress(0);
    setShowReport(false);
    video.pause();

    if (rampEngineRef.current) {
      // RAMP queue counter: every frame at RAMP_FPS, from a little before the match start (it
      // calibrates on the pre-staged ARTIFACTS there) to SETTLE_SEC after the buzzer. With no
      // window set by hand the pass starts at the beginning of the video and stops once the
      // window found from the field is final.
      resetScorer();
      const savedAt = video.currentTime;
      const scorer = await ensureScorer();
      if (!scorer) {
        pushLog("[RAMP] counter could not start (no camera pose or no RAMP in view)");
        setProcessing("idle");
        return;
      }
      const t0 = Math.max(0, matchStart - 3);
      const manualEnd = scoringWindowOf(matchStart, matchEnd, null).buzzer;
      let t1 = manualEnd != null ? Math.min(manualEnd + SETTLE_SEC, video.duration) : video.duration;
      let nextWindowCheck = t0 + 1;
      setEvents((prev) => prev.filter((e) => e.method === "manual"));
      const started = performance.now();
      // where the time goes (ms, summed): shown in the status line and the debug log
      const ms = { seek: 0, grab: 0, count: 0, ui: 0 };
      let frames = 0;
      let lastUi = 0;
      for (let i = 0; ; i++) {
        const t = t0 + i / RAMP_FPS;
        if (t > t1 || cancelRef.current) break;
        const a = performance.now();
        await seekTo(video, t);
        const b = performance.now();
        const f = grabCurrentFrame(counterSizeRef.current);
        const c = performance.now();
        if (f) {
          scorer.push(f, t);
          const v2 = v2Ref.current;
          if (v2) {
            for (const s of scorer.strips(f)) v2.add(s.alliance, t, s.strip);
            if (v2.pendingStrips >= 32) await v2.flush();
          }
          readBarAt(t);
        }
        if (manualEnd == null && t >= nextWindowCheck) {
          nextWindowCheck = t + 1;
          const bw = barRef.current.present ? barRef.current.window() : null;
          const auto = scorer.matchWindow(video.duration);
          // with the score bar: on past the buzzer until its counts have settled (at most POST_MAX_SEC)
          const settled = bw ? barRef.current.settledAt() : null;
          const barEnd = bw ? (settled != null ? Math.max(settled, bw.buzzer + SETTLE_SEC) : bw.buzzer + POST_MAX_SEC) : Infinity;
          if (bw && barEnd < t1) {
            t1 = Math.min(video.duration, barEnd);
            pushLog(`[MATCH] read from the score bar's clock: start ${bw.start.toFixed(1)}s, TELEOP ${bw.teleopStart.toFixed(1)}s, buzzer ${bw.buzzer.toFixed(1)}s — analysing to ${t1.toFixed(1)}s${settled != null ? " (the score bar's counts settled)" : ""}`);
          } else if (!bw && auto?.final && auto.buzzer + SETTLE_SEC < t1) {
            t1 = Math.min(video.duration, auto.buzzer + SETTLE_SEC);
            pushLog(`[MATCH] found from the field: start ${auto.start.toFixed(1)}s, TELEOP ${auto.teleopStart.toFixed(1)}s, buzzer ${auto.buzzer.toFixed(1)}s — analysing to ${t1.toFixed(1)}s`);
          }
        }
        const now = performance.now();
        ms.seek += b - a;
        ms.grab += c - b;
        ms.count += now - c;
        frames++;
        if (now - lastUi > 1500) {
          lastUi = now;
          setProgress(Math.min(1, (t - t0) / Math.max(0.001, t1 - t0)));
          applyRamp(scorer);
          if (debugModeRef.current) setLaneViews(scaleLaneViews(scorer.laneViews(), (videoRef.current?.videoWidth ?? 1) / (counterSizeRef.current?.width ?? videoRef.current?.videoWidth ?? 1)));
          ms.ui += performance.now() - now;
          diagRef.current.status = `Analyzing — ${((performance.now() - started) / frames).toFixed(0)} ms/frame (seek ${(ms.seek / frames).toFixed(0)}, grab ${(ms.grab / frames).toFixed(0)}, counter ${(ms.count / frames).toFixed(0)}, display ${(ms.ui / frames).toFixed(0)})`;
        }
      }
      await v2Ref.current?.flush();
      applyRamp(scorer);
      const res = scorer.results();
      await seekTo(video, Math.min(savedAt, t1));
      setProgress(1);
      setProcessing("done");
      pushLog(`[RAMP] offline analysis complete in ${((performance.now() - started) / 1000).toFixed(0)}s (${frames} frames; per frame: seek ${(ms.seek / Math.max(1, frames)).toFixed(0)} ms, grab ${(ms.grab / Math.max(1, frames)).toFixed(0)} ms, counter ${(ms.count / Math.max(1, frames)).toFixed(0)} ms, display ${(ms.ui / Math.max(1, frames)).toFixed(0)} ms) — ${res.map((r) => `${r.alliance.toUpperCase()} ${r.count.total} (${r.count.quality.confidence})`).join(", ")}`);
      return;
    }

    const redCfg = candidateCfgFrom(colorTargetsRef.current, redSensRef.current, RED_COLOR_FLOORS);
    const blueCfg = candidateCfgFrom(colorTargetsRef.current, blueSensRef.current);
    const redTracker = new GateMultiTracker(trackerCfgFrom(redZone, redDir, redSingleRef.current, DEFAULT_RED_MAX_CLUMP));
    const blueTracker = new GateMultiTracker(trackerCfgFrom(blueZone, blueDir, blueSingleRef.current, DEFAULT_BLUE_MAX_CLUMP));
    const collected: ScoreEvent[] = [];
    // Respect the scoring window: analyze only match start → buzzer (or video end).
    const start = Math.max(0, matchStart);
    const end = matchEnd != null ? Math.min(matchEnd, video.duration) : video.duration;
    const step = DETAIL_STEPS[detail];
    const savedTime = video.currentTime;

    const pushCrossings = (crossings: CrossingEvent[], alliance: AllianceColor, t: number) => {
      for (const c of crossings) {
        const n = Math.max(1, c.estimatedCount);
        collected.push({
          id: nextId(),
          videoTime: t,
          alliance,
          type: "classified",
          color: c.color === "unknown" ? "unknown" : c.color,
          points: artifactPointsFor("classified") * n,
          method: "cv",
          status: "auto",
          confidence: c.confidence,
          source: "gate_detection",
          zoneX: c.centerX,
          trackId: c.trackId,
          count: n,
          note: n > 1 ? `Clump ×${n} (area estimate) — review` : undefined,
        });
      }
    };

    for (let t = start; t <= end; t += step) {
      if (cancelRef.current) break;
      await seekTo(video, t);
      const rs = redEnabledRef.current ? sampleZone(video, redZone) : { data: null, w: 0, h: 0 };
      const bs = blueEnabledRef.current ? sampleZone(video, blueZone) : { data: null, w: 0, h: 0 };
      const rU = redTracker.update(rs.data ? detectCandidates(rs.data, rs.w, rs.h, redCfg) : []);
      const bU = blueTracker.update(bs.data ? detectCandidates(bs.data, bs.w, bs.h, blueCfg) : []);
      pushCrossings(rU.crossings, "red", t);
      pushCrossings(bU.crossings, "blue", t);
      setProgress(Math.min(1, (t - start) / Math.max(0.001, end - start)));
    }

    setEvents((prev) => [...prev.filter((e) => e.method === "manual"), ...collected]);
    await seekTo(video, Math.min(savedTime, end));
    setProgress(1);
    setProcessing("done");
    pushLog(`[OFFLINE] complete — ${collected.length} crossings (RED ${collected.filter((e) => e.alliance === "red").length}, BLUE ${collected.filter((e) => e.alliance === "blue").length})`);
    // ensureScorer / resetScorer read the current placement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleZone, redZone, blueZone, redDir, blueDir, detail, matchStart, matchEnd, applyRamp]);

  function sampleColorAt(nx: number, ny: number) {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !sampleMode) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const patch = 10;
    canvas.width = patch;
    canvas.height = patch;
    ctx.drawImage(video, nx * vw - patch / 2, ny * vh - patch / 2, patch, patch, 0, 0, patch, patch);
    const dt = ctx.getImageData(0, 0, patch, patch).data;
    let r = 0, g = 0, b = 0;
    const n = dt.length / 4;
    for (let i = 0; i < dt.length; i += 4) {
      r += dt[i];
      g += dt[i + 1];
      b += dt[i + 2];
    }
    const target = targetFromSample(r / n, g / n, b / n, sampleMode);
    setColorTargets((prev) => [...prev.filter((t) => t.label !== sampleMode), target]);
    setSampleMode(null);
  }

  // Mirror the mutable diag ref into React state on a throttled interval so the
  // per-frame loop never forces a render.
  useEffect(() => {
    if (!liveOn && !debugMode) return;
    const id = window.setInterval(() => {
      const d = diagRef.current;
      setDiag({ ...d, red: { ...d.red }, blue: { ...d.blue }, log: [...d.log] });
    }, 150);
    return () => window.clearInterval(id);
  }, [liveOn, debugMode]);

  // --- Diagnostic / test handlers ---
  function testAdd(alliance: AllianceColor) {
    const t = videoRef.current?.currentTime ?? currentTime;
    setEvents((prev) => [
      ...prev,
      {
        id: nextId(),
        videoTime: t,
        alliance,
        type: "classified",
        color: "unknown",
        points: artifactPointsFor("classified"),
        method: "manual",
        status: "confirmed",
        confidence: "high",
        source: "test",
        note: "Test +3",
      },
    ]);
    pushLog(`[TEST] ${alliance.toUpperCase()} +3 (pipeline test)`);
  }

  function resetTestScores() {
    setEvents((prev) => prev.filter((e) => e.source !== "test"));
  }

  function clearDetectionEvents() {
    setEvents((prev) => prev.filter((e) => e.method !== "cv"));
    const d = diagRef.current;
    d.red.totalCrossings = 0;
    d.blue.totalCrossings = 0;
    scoredUpToRef.current = -1;
    resetScorer();
    pushLog("[CLEAR] removed automatic detection events");
  }

  // Analyze the paused frame: report candidate counts, centres, matched pixels, and
  // which side of the scoring line each candidate is on. Purely diagnostic.
  function analyzeCurrentFrame() {
    const v = videoRef.current;
    if (!v) return;
    const redCfg = candidateCfgFrom(colorTargetsRef.current, redSensRef.current, RED_COLOR_FLOORS);
    const blueCfg = candidateCfgFrom(colorTargetsRef.current, blueSensRef.current);
    const rs = redEnabledRef.current ? sampleZone(v, redZone) : { data: null, w: 0, h: 0 };
    const bs = blueEnabledRef.current ? sampleZone(v, blueZone) : { data: null, w: 0, h: 0 };
    const redCands = rs.data ? detectCandidates(rs.data, rs.w, rs.h, redCfg) : [];
    const blueCands = bs.data ? detectCandidates(bs.data, bs.w, bs.h, blueCfg) : [];
    const redPx = rs.data ? analyzeZonePixels(rs.data, rs.w, rs.h, redCfg).matchedPixels : 0;
    const bluePx = bs.data ? analyzeZonePixels(bs.data, bs.w, bs.h, blueCfg).matchedPixels : 0;

    const describe = (cands: Candidate[], line: number, dir: ScoringDirection) =>
      cands.map((c, i) => `A${i + 1}:${c.color}@(${c.centerX.toFixed(2)},${c.centerY.toFixed(2)})[${sideOfLine(c.centerY, line, dir)}]`).join(" ");

    const d = diagRef.current;
    d.red = { ...d.red, detector: "paused", candidates: redCands.length, present: redCands.length > 0, crossingThisFrame: 0 };
    d.blue = { ...d.blue, detector: "paused", candidates: blueCands.length, present: blueCands.length > 0, crossingThisFrame: 0 };
    d.status = `Analyzed @ ${fmt(v.currentTime)} — RED ${redCands.length} cand / ${redPx}px · BLUE ${blueCands.length} cand / ${bluePx}px`;
    pushLog(`[ANALYZE] t=${v.currentTime.toFixed(3)} RED{${describe(redCands, redZone.line, redDir)}} px=${redPx} | BLUE{${describe(blueCands, blueZone.line, blueDir)}} px=${bluePx}`);

    drawCropWithOverlay(redCropRef.current, rs.data, rs.w, rs.h, redCands, redZone.line, redDir, false);
    drawCropWithOverlay(blueCropRef.current, bs.data, bs.w, bs.h, blueCands, blueZone.line, blueDir, false);
    paintMask(redMaskRef.current, rs.data, rs.w, rs.h, redSensRef.current, RED_COLOR_FLOORS);
    paintMask(blueMaskRef.current, bs.data, bs.w, bs.h, blueSensRef.current, BLUE_COLOR_FLOORS);
    setDiag({ ...d, red: { ...d.red }, blue: { ...d.blue }, log: [...d.log] });
  }

  function exportDebugLog() {
    const payload = { diag: diagRef.current, events, redZone, blueZone, redDir, blueDir, colorTargets, redSensitivity, blueSensitivity, redSingleArea, blueSingleArea, redScore, blueScore, roiPlacement: { stage: placeStage, summary: placeSummary, failure: placeFailure, lockTime: lockTimeRef.current, enabled: { red: redEnabled, blue: blueEnabled } }, roiPlacementLog: readPlacementLog(), rampEngine, rampAuto, rampCounts: rampResults.map((r) => ({ alliance: r.alliance, t0: r.t0, fps: r.fps, total: r.count.total, quality: r.count.quality, periods: r.count.periods.map((p) => ({ from: p.from, release: p.release, queueGain: p.queueGain, entries: p.entryFrames.length, counted: p.counted })) })) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auto-scout-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function updateEvent(id: string, patch: Partial<ScoreEvent>) {
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== id) return e;
        const merged = { ...e, ...patch };
        if (patch.type) merged.points = artifactPointsFor(patch.type) * (merged.count ?? 1);
        return merged;
      }),
    );
  }

  function addMissed(alliance: AllianceColor) {
    const v = videoRef.current;
    const t = v ? v.currentTime : currentTime;
    setEvents((prev) => [
      ...prev,
      {
        id: nextId(),
        videoTime: t,
        alliance,
        type: "classified",
        color: "unknown",
        points: artifactPointsFor("classified"),
        method: "manual",
        status: "confirmed",
        confidence: "high",
        source: "manual",
        note: "Manually added",
      },
    ]);
  }

  function seekVideo(t: number) {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, t - 0.4);
  }

  const statusLabel =
    processing === "analyzing"
      ? `Analyzing ${Math.round(progress * 100)}%`
      : processing === "done"
        ? "Analysis complete"
        : videoUrl
          ? "Ready"
          : "No video";

  return (
    <main
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8"
      style={{ background: "var(--scout-bg)" }}
    >
      <div className="flex items-center justify-between">
        <Link href="/video-scouting" className="text-sm font-medium text-white/40 transition hover:text-white/70">
          ← Scouting Modes
        </Link>
        <div className="text-right">
          <p className="text-sm font-black tracking-wide text-white">Auto Scouting</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--scout-accent)" }}>
            DECODE · Experimental CV
          </p>
        </div>
      </div>

      {/* hidden processing canvas */}
      <canvas ref={canvasRef} className="hidden" />

      <AutoVideoPlayer
        videoUrl={videoUrl}
        videoRef={videoRef}
        onUpload={handleUpload}
        redZone={redZone}
        blueZone={blueZone}
        currentTime={currentTime}
        duration={meta.duration}
        statusLabel={statusLabel}
        videoAspect={videoAspect}
        samplingColor={sampleMode}
        onSample={sampleColorAt}
        redDir={redDir}
        blueDir={blueDir}
        showOverlays={placeStage !== "idle" && placeStage !== "finding" && placeStage !== "tapping"}
        redEnabled={redEnabled}
        blueEnabled={blueEnabled}
        onZoneChange={placeStage === "finding" || placeStage === "tapping" ? undefined : manualZone}
        overlay={
          <PlacementOverlay
            width={meta.width}
            height={meta.height}
            rois={placeStage === "finding" || placeStage === "tapping" ? [] : overlayRois}
            lowConfidence={placeStage === "proposed" && placeSummary?.confidence === "low"}
            label={null}
            tapping={placeStage === "tapping" ? (taps ?? []) : null}
            onTap={handleTap}
            onUndoTap={() => setTaps((t) => (t && t.length ? t.slice(0, -1) : t))}
            onCancelTaps={() => {
              setTaps(null);
              setPlaceStage(overlayRois.length ? "proposed" : "unplaced");
            }}
            tapLabels={fieldModel ? fieldModel.perimeterCorners.map((c, i) => `${i + 1}: ${c.label}`) : []}
            debug={fieldDebug ? overlayDebug : null}
            model={fieldModel}
            lanes={debugMode && rampEngine ? laneViews : undefined}
          />
        }
      />

      {videoUrl && (
        <>
          <RoiPlacementPanel
            stage={placeStage}
            progress={placeProgress}
            summary={placeSummary}
            failure={placeFailure}
            countingActive={liveOn || processing === "analyzing"}
            debugOn={fieldDebug}
            onConfirm={confirmPlacement}
            onRefind={() => void startPlacement(videoRef.current?.currentTime ?? 0)}
            onStartTaps={() => {
              setTaps([]);
              setPlaceStage("tapping");
            }}
            onToggleDebug={() => setFieldDebug((d) => !d)}
          />

          {/* Goal calibration + processing controls */}
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-white/45">{rampEngine ? "Automatic calibration" : "Goal Calibration & Processing"}</h3>
            {rampEngine ? (
              <>
                <p className="mb-3 text-[11px] text-white/45">
                  The RAMPS were found from the field. Everything the counter uses is measured from this video and shown below — the size of
                  one ARTIFACT on each RAMP (clump size), how much each slot counts (sensitivity), the ARTIFACT colours and the empty RAMP.
                  Nothing needs tuning by hand.
                </p>
                <RampCalibration auto={rampAuto} results={rampResults} />
                <details className="mt-3 text-[11px] text-white/40">
                  <summary className="cursor-pointer select-none">Adjust the RAMP boxes by hand</summary>
                  <p className="mt-2">
                    Only if the boxes are not on the RAMPS. Dragging a box (or its corner) or using these sliders replaces the automatic
                    placement for this session and switches to the simpler gate-line counter.
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {redEnabled && <ZoneControls label="Red ramp zone" color="var(--scout-red)" zone={redZone} onChange={(z) => manualZone("red", z)} />}
                    {blueEnabled && <ZoneControls label="Blue ramp zone" color="var(--scout-blue)" zone={blueZone} onChange={(z) => manualZone("blue", z)} />}
                  </div>
                </details>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setRedSensitivity(DEFAULT_RED_SENSITIVITY);
                      setBlueSensitivity(DEFAULT_BLUE_SENSITIVITY);
                      setRedSingleArea(DEFAULT_RED_SINGLE_AREA);
                      setBlueSingleArea(DEFAULT_BLUE_SINGLE_AREA);
                    }}
                    className="chip"
                  >
                    Reset detection settings
                  </button>
                </div>
                <p className="mt-4 text-[11px] text-white/40">
                  The <span style={{ color: "var(--scout-red)" }}>red</span> and{" "}
                  <span style={{ color: "var(--scout-blue)" }}>blue</span> boxes are placed over each alliance&apos;s RAMP
                  automatically. To adjust one, drag it on the video (or its corner to resize) or use these sliders — that
                  overrides the automatic placement for this session. The thin line across each box is the scoring line.
                  Only these boxes are analyzed. The detector runs continuously (no match phases).
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {redEnabled && <ZoneControls label="Red ramp zone" color="var(--scout-red)" zone={redZone} onChange={(z) => manualZone("red", z)} />}
                  {blueEnabled && <ZoneControls label="Blue ramp zone" color="var(--scout-blue)" zone={blueZone} onChange={(z) => manualZone("blue", z)} />}
                </div>
              </>
            )}
            {(!redEnabled || !blueEnabled) && placeStage !== "finding" && (
              <p className="mt-2 text-[11px] text-white/40">
                Only the {redEnabled ? "RED" : "BLUE"} ramp is in view, so only that alliance is counted.{" "}
                <button type="button" className="underline" onClick={() => (redEnabled ? setBlueEnabled(true) : setRedEnabled(true))}>
                  Add a {redEnabled ? "blue" : "red"} box anyway
                </button>
              </p>
            )}

            {/* Artifact colour calibration — the biggest accuracy lever (legacy gate-line detector). */}
            {!rampEngine && (
            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-white/50">
                Artifact colours {sampleMode && <span style={{ color: "var(--scout-accent)" }}>· pausing to sample…</span>}
              </p>
              <p className="mb-2 text-[11px] text-white/40">
                Pause on a clear frame, then sample each artifact colour by clicking one on the video. This
                tunes detection to your footage&apos;s actual lighting.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSampleMode((m) => (m === "purple" ? null : "purple"))}
                  className="chip"
                  style={{ borderColor: "#a855f7", color: "#c99bff" }}
                >
                  {sampleMode === "purple" ? "Click a purple artifact…" : "Sample purple"}
                </button>
                <button
                  type="button"
                  onClick={() => setSampleMode((m) => (m === "green" ? null : "green"))}
                  className="chip"
                  style={{ borderColor: "#26d94a", color: "#7ef29a" }}
                >
                  {sampleMode === "green" ? "Click a green artifact…" : "Sample green"}
                </button>
                <button type="button" onClick={() => setColorTargets(DEFAULT_TARGETS)} className="chip">
                  Reset colours
                </button>
                <span className="text-[11px] text-white/40">
                  {colorTargets.map((t) => `${t.label} ~${Math.round(t.hue)}°`).join(" · ")}
                </span>
              </div>
            </div>
            )}

            {!rampEngine && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/45">
                  Detection detail (offline pass)
                </span>
                <div className="flex gap-1.5">
                  {(["fast", "balanced", "thorough"] as Detail[]).map((dd) => (
                    <button
                      key={dd}
                      type="button"
                      onClick={() => setDetail(dd)}
                      className="flex-1 rounded-lg border py-1.5 text-xs font-bold capitalize transition"
                      style={
                        detail === dd
                          ? { background: "var(--scout-accent)", borderColor: "var(--scout-accent)", color: "#04140c" }
                          : { background: "transparent", borderColor: "var(--scout-border)", color: "#9aa39d" }
                      }
                    >
                      {dd}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-white/50">
                  <span style={{ color: "var(--scout-red)" }}>Red</span> sensitivity ({redSensitivity.toFixed(1)}×) — turn up for a dim / shadowed goal
                  <input
                    type="range"
                    min={0.5}
                    max={MAX_SENSITIVITY}
                    step={0.1}
                    value={redSensitivity}
                    onChange={(e) => setRedSensitivity(Number(e.target.value))}
                    style={{ accentColor: "var(--scout-red)" }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-white/50">
                  <span style={{ color: "var(--scout-blue)" }}>Blue</span> sensitivity ({blueSensitivity.toFixed(1)}×)
                  <input
                    type="range"
                    min={0.5}
                    max={MAX_SENSITIVITY}
                    step={0.1}
                    value={blueSensitivity}
                    onChange={(e) => setBlueSensitivity(Number(e.target.value))}
                    style={{ accentColor: "var(--scout-blue)" }}
                  />
                </label>
              </div>
            </div>
            )}

            {debugMode && (placementCam != null || forceLegacy) && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
                Counting engine: <span className="font-bold text-white/80">{rampEngine ? "RAMP queue (automatic)" : "Legacy gate line"}</span>
                <button type="button" className="chip" disabled={liveOn || processing === "analyzing"} onClick={() => { resetScorer(); setForceLegacy((f) => !f); }}>
                  Switch to {rampEngine ? "legacy gate line" : "RAMP queue"}
                </button>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {processing !== "analyzing" ? (
                <button
                  type="button"
                  onClick={runAnalysis}
                  disabled={placeStage !== "confirmed"}
                  title={placeStage !== "confirmed" ? "Confirm the ramp ROI first" : undefined}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-black disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: "var(--scout-accent)" }}
                >
                  {processing === "done" ? "Re-run offline analysis" : "Start offline analysis"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                  className="rounded-xl border border-red-500/50 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-red-300"
                >
                  Cancel
                </button>
              )}
              {processing === "analyzing" && (
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: "var(--scout-accent)" }} />
                </div>
              )}
            </div>
            <p className="mt-3 text-[11px] text-white/35">
              {rampEngine
                ? "The RAMP counter runs entirely in your browser. The offline pass reads every frame of the match (about 15 per second) and takes a few minutes; every counted ARTIFACT is reviewable below — treat it as an assist, not a referee."
                : "Experimental color-detection CV runs entirely in your browser over the two goal zones shown on the video. Every detection is reviewable below — treat it as an assist, not a referee."}
            </p>
          </div>

          {/* Live detection controls */}
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/45">Live Detection</h3>
                <p className="mt-1 text-[11px] text-white/40">
                  {rampEngine
                    ? "Turn on, then play the match from the start. The RAMP counter calibrates on the pre-staged ARTIFACTS, then updates the count about once a second (provisional until the buzzer)."
                    : "Turn on, then press play. Every artifact crossing a gate line scores +3 live (works at 0.25×–2×)."}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDebugMode((val) => !val)}
                  className="rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide transition"
                  style={
                    debugMode
                      ? { background: "var(--scout-accent)", color: "#04140c" }
                      : { border: "1px solid var(--scout-border)", color: "#9aa39d" }
                  }
                >
                  Debug: {debugMode ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  onClick={() => setLiveOn((val) => !val)}
                  disabled={!liveOn && placeStage !== "confirmed"}
                  title={!liveOn && placeStage !== "confirmed" ? "Confirm the ramp ROI first" : undefined}
                  className="rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={
                    liveOn
                      ? { background: "var(--scout-accent)", color: "#04140c" }
                      : { border: "1px solid var(--scout-accent)", color: "var(--scout-accent)" }
                  }
                >
                  {liveOn ? "Live: ON" : "Live: OFF"}
                </button>
              </div>
            </div>

            {/* Processing status indicator */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px]">
              <span className="font-bold" style={{ color: "var(--scout-accent)" }}>{diag.status}</span>
              <span className="text-white/45">Frames <span className="tabular-nums text-white/80">{diag.framesAnalyzed}</span></span>
              {rampEngine ? (
                <>
                  <span className="text-white/45">RED classified <span className="tabular-nums text-white/80">{diag.red.totalCrossings}</span></span>
                  <span className="text-white/45">BLUE classified <span className="tabular-nums text-white/80">{diag.blue.totalCrossings}</span></span>
                </>
              ) : (
                <>
                  <span className="text-white/45">RED cand <span className="tabular-nums text-white/80">{diag.red.candidates}</span> · crossings <span className="tabular-nums text-white/80">{diag.red.totalCrossings}</span></span>
                  <span className="text-white/45">BLUE cand <span className="tabular-nums text-white/80">{diag.blue.candidates}</span> · crossings <span className="tabular-nums text-white/80">{diag.blue.totalCrossings}</span></span>
                </>
              )}
            </div>

            {/* Match window: scrub to the buzzer and mark it — scoring auto-stops there. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px]">
              <span className="font-semibold uppercase tracking-wide text-white/45">Match window</span>
              <button
                type="button"
                className="chip"
                onClick={() => setMatchStart(videoRef.current?.currentTime ?? currentTime)}
              >
                Set start = {fmt(currentTime)}
              </button>
              <button
                type="button"
                className="chip"
                style={{ borderColor: "var(--scout-accent)", color: "var(--scout-accent)" }}
                onClick={() => {
                  setMatchEnd(videoRef.current?.currentTime ?? currentTime);
                  matchEndedRef.current = false;
                  setMatchComplete(false);
                }}
              >
                Set buzzer = {fmt(currentTime)}
              </button>
              <button
                type="button"
                className="chip"
                title="Forget the times set by hand and use the match found from the field"
                onClick={() => {
                  setMatchStart(0);
                  setMatchEnd(null);
                  matchEndedRef.current = false;
                  setMatchComplete(false);
                }}
              >
                {rampEngine ? "Automatic" : "Clear"}
              </button>
              <span className="text-white/50">
                {scoringWindow.buzzer != null ? (
                  <>
                    Scoring <span className="font-mono text-white/80">{fmt(scoringWindow.start)}</span> → buzzer{" "}
                    <span className="font-mono text-white/80">{fmt(scoringWindow.buzzer)}</span>{" "}
                    {scoringWindow.source === "scoreboard"
                      ? `· read from the broadcast score bar's clock (AUTO, the ${barWindow?.transitionSec ?? 8} s pause, TELEOP from ${fmt(barWindow?.teleopStart ?? 0)})`
                      : scoringWindow.source === "auto"
                      ? `· found from the field (AUTO, the ${autoWindow?.transitionSec ?? 8} s pause, TELEOP from ${fmt(autoWindow?.teleopStart ?? 0)})`
                      : scoringWindow.source === "start"
                        ? "· 2:38 after the start you set (30 s AUTO, 8 s pause, 2:00 TELEOP)"
                        : "· set by hand"}
                    {scoringWindow.source === "scoreboard" && barCounts ? (
                      <>
                        {" "}· the scorekeepers&apos; last entries after the buzzer count until the bar&apos;s numbers settle
                        {barSettledAt != null ? (
                          <>
                            {" "}(<span className="font-mono text-white/80">{fmt(barSettledAt)}</span>); nothing after that
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {" "}· ARTIFACTS still in the air count until{" "}
                        <span className="font-mono text-white/80">{fmt(scoringWindow.buzzer + SETTLE_SEC)}</span>; nothing after that
                      </>
                    )}
                  </>
                ) : rampEngine ? (
                  processing === "done" ? (
                    <span className="text-amber-200/90">
                      The match was not found in this video (it needs the pause between AUTO and TELEOP). The score covers the whole video — set the start and buzzer.
                    </span>
                  ) : (
                    "Finding the match from the robots' motion — known about a minute into TELEOP (it needs the pause between AUTO and TELEOP); or set the start and buzzer"
                  )
                ) : (
                  <>
                    Scoring <span className="font-mono text-white/80">{fmt(matchStart)}</span> → <span className="font-mono text-white/80">video end</span>
                  </>
                )}
              </span>
            </div>
          </div>

          {debugMode && (
            <DebugPanel
              diag={diag}
              redArtifacts={redScore.artifacts}
              blueArtifacts={blueScore.artifacts}
              redArtifactPoints={redScore.artifactPoints}
              blueArtifactPoints={blueScore.artifactPoints}
              redCropRef={redCropRef}
              blueCropRef={blueCropRef}
              redMaskRef={redMaskRef}
              blueMaskRef={blueMaskRef}
              redDir={redDir}
              blueDir={blueDir}
              redSingleArea={redSingleArea}
              blueSingleArea={blueSingleArea}
              onRedSingleChange={setRedSingleArea}
              onBlueSingleChange={setBlueSingleArea}
              onReverseRed={() => setRedDir((d) => (d === "downward" ? "upward" : "downward"))}
              onReverseBlue={() => setBlueDir((d) => (d === "downward" ? "upward" : "downward"))}
              onTest={testAdd}
              onResetTest={resetTestScores}
              onAnalyzeFrame={analyzeCurrentFrame}
              onClearDetections={clearDetectionEvents}
              onExport={exportDebugLog}
              rampSection={rampEngine ? <RampDebug auto={rampAuto} results={rampResults} /> : undefined}
            />
          )}

          {/* Match-complete results banner (shown when playback hits the buzzer) */}
          {matchComplete && (
            <div className="rounded-2xl border p-5 text-center" style={{ borderColor: "var(--scout-accent)", background: "rgba(34,255,160,0.08)" }}>
              <p className="text-xs font-black uppercase tracking-widest" style={{ color: "var(--scout-accent)" }}>
                Match Complete — Final Results
              </p>
              <div className="mt-3 flex items-center justify-center gap-6">
                <div className="text-right">
                  <span className="block text-sm font-bold uppercase" style={{ color: "var(--scout-red)" }}>Red</span>
                  <span className="text-4xl font-black tabular-nums text-white">{redScore.total}</span>
                </div>
                <span className="text-2xl font-black text-white/30">–</span>
                <div className="text-left">
                  <span className="block text-sm font-bold uppercase" style={{ color: "var(--scout-blue)" }}>Blue</span>
                  <span className="text-4xl font-black tabular-nums text-white">{blueScore.total}</span>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-white/50">
                Winner:{" "}
                <span className="font-bold text-white">
                  {redScore.total === blueScore.total ? "Tie" : redScore.total > blueScore.total ? "RED Alliance" : "BLUE Alliance"}
                </span>
                {" · "}scoring stopped at the buzzer
                {scoringWindow.buzzer != null
                  ? scoringWindow.source === "scoreboard" && barCounts
                    ? ` (${fmt(scoringWindow.buzzer)}, ${windowSourceText(scoringWindow.source)}; the scorekeepers' entries counted until the bar's numbers settled${barSettledAt != null ? ` at ${fmt(barSettledAt)}` : ""})`
                    : ` (${fmt(scoringWindow.buzzer)}, ${windowSourceText(scoringWindow.source)}; ARTIFACTS in the air counted until ${fmt(scoringWindow.buzzer + SETTLE_SEC)})`
                  : ""}
              </p>
              <p className="mt-1 text-[11px] text-white/50">
                {barCounts
                  ? "ARTIFACTS scored as the scorekeepers counted them, read from the broadcast's score bar (CLASSIFIED and OVERFLOW)."
                  : v2State === "ready"
                    ? `ARTIFACTS counted from the video: each one seen coming onto a RAMP (CLASSIFIED). ${v2Seen.map((x) => `${x.alliance === "red" ? "Red" : "Blue"} RAMP seen ${Math.round(100 * x.share)}% of the match${x.unscored != null ? ` — too small in this video to count (ARTIFACTS ${smallRamps.get(x.alliance)?.toFixed(0) ?? "<6"} px apart): not scored; the counter's unreliable estimate was ${Math.round(x.unscored)}` : ""}.`).join(" ")}${missingRamps.map((a) => ` ${a === "red" ? "Red" : "Blue"} RAMP not in the picture: not counted.`).join("")}`
                    : "ARTIFACTS counted from the video by the RAMP queue counter (CLASSIFIED)."}{" "}
                PATTERN, LEAVE, BASE and penalties are entered by hand below.
              </p>
            </div>
          )}

          {/* Live scoreboard */}
          <Scoreboard red={redScore} blue={blueScore} latestEvent={latestEvent} />
          {barCounts && (
            <div className="rounded-xl border border-emerald-400/40 bg-emerald-400/5 px-4 py-2 text-xs text-white/75">
              <span className="font-semibold text-emerald-300">Official counts from the broadcast score bar</span> (the scorekeepers&apos; live numbers, read from the video):{" "}
              <span style={{ color: "var(--scout-red)" }}>
                RED {barCounts.red.classified} classified · {barCounts.red.overflow} overflow
              </span>{" "}
              ·{" "}
              <span style={{ color: "var(--scout-blue)" }}>
                BLUE {barCounts.blue.classified} classified · {barCounts.blue.overflow} overflow
              </span>
              {visionCounts && (
                <span className="block text-white/45">
                  The RAMP counter&apos;s own count, as a check: red {visionCounts.red}, blue {visionCounts.blue} classified. PATTERN, LEAVE, BASE and penalties are not included.
                </span>
              )}
            </div>
          )}
          {rampEngine && !barCounts && v2State !== "off" && (
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/60">
              {v2State === "ready" ? (
                <>
                  Counted from the video: every ARTIFACT seen coming onto each RAMP, whether it rolls onto the queue or straight out through an open GATE (v2 RAMP counter). PATTERN, LEAVE, BASE and penalties are not included.
                  {v2Seen.length > 0 && (
                    <span className="block">
                      {v2Seen.map((s) => (
                        <span key={s.alliance} className={s.share < 0.8 || s.unscored != null ? "text-amber-300" : undefined}>
                          {s.alliance.toUpperCase()} RAMP seen {Math.round(100 * s.share)}% of the match
                          {s.share < 0.8 && s.unscored == null ? " — ARTIFACTS that came on while it was not seen are not counted" : ""}
                          {s.unscored != null
                            ? ` — too small in this video to count: ARTIFACTS are ${smallRamps.get(s.alliance)?.toFixed(0) ?? `under ${MIN_RELIABLE_ARTIFACT_PX}`} px apart on it (needs ${MIN_RELIABLE_ARTIFACT_PX}+; record closer or at a higher resolution). Its ARTIFACTS are not scored; the counter's estimate, unreliable at this size, was ${Math.round(s.unscored)}`
                            : ""}
                          {". "}
                        </span>
                      ))}
                      {missingRamps.map((a) => (
                        <span key={a} className="text-amber-300">
                          {a.toUpperCase()} RAMP not in the picture — its ARTIFACTS are not counted (0 is shown).{" "}
                        </span>
                      ))}
                    </span>
                  )}
                </>
              )
                : v2State === "loading"
                  ? "Loading the v2 RAMP counter…"
                  : "The v2 RAMP counter could not load in this browser — counting with the v1 queue counter."}
            </div>
          )}

          {/* Manual pattern/endgame + event history */}
          <ManualPanel
            red={red}
            blue={blue}
            onChangeRed={(patch) => setRed((r) => ({ ...r, ...patch }))}
            onChangeBlue={(patch) => setBlue((b) => ({ ...b, ...patch }))}
          />
          <EventList events={events} onUpdate={updateEvent} onAddMissed={addMissed} onSeek={seekVideo} />

          {/* Final report */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setShowReport((s) => !s)}
              className="rounded-xl border px-6 py-3 text-sm font-bold uppercase tracking-wide"
              style={{ borderColor: "var(--scout-accent)", color: "var(--scout-accent)" }}
            >
              {showReport ? "Hide report" : "View final report"}
            </button>
          </div>

          {showReport && (
            <AutoReport
              videoName={videoName}
              meta={meta}
              events={events}
              redScore={redScore}
              blueScore={blueScore}
            />
          )}
        </>
      )}

      <p className="pb-6 text-center text-[11px] text-white/25">
        Scoring rules: {DECODE_RULES.manualVersion}. Auto Scouting results are kept in memory only and are discarded when you leave this page.
      </p>
    </main>
  );
}
