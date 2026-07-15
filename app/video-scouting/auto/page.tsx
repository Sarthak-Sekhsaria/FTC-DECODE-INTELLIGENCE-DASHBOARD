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
import {
  computeAllianceScore,
  emptyManualEntry,
  artifactPointsFor,
  type AllianceColor,
  type AllianceManualEntry,
  type ScoreEvent,
} from "@/lib/scouting/autoTypes";
import { DECODE_RULES } from "@/lib/scouting/decodeRules";

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

// A box over each goal collection tube. Artifacts drop in and cross the scoring
// line as they enter. Only these two boxes are ever analyzed — never the full
// field. Defaults are tuned for the FTC Championship overhead broadcast framing
// (goal tubes at ~x0.31 blue / ~x0.69 red); adjust the sliders for other angles.
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
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
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

  // Live detection loop. Dual driver (requestVideoFrameCallback + a 33 ms interval
  // watchdog) so it runs at any playback speed and even where rVFC never fires;
  // both feed one media-time-deduped processFrame. Detects EVERY candidate in each
  // gate crop and lets each cross independently (no global gate lock).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !liveOn) return;
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

      const rs = sampleZone(v, redZone);
      const bs = sampleZone(v, blueZone);
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
  }, [liveOn, sampleZone, paintMask, addLiveEvents, redZone, blueZone, redDir, blueDir]);

  // Offline pass: seek frame-by-frame across the whole video and score crossings.
  const runAnalysis = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    cancelRef.current = false;
    setProcessing("analyzing");
    setProgress(0);
    setShowReport(false);
    video.pause();

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
      const rs = sampleZone(video, redZone);
      const bs = sampleZone(video, blueZone);
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
  }, [sampleZone, redZone, blueZone, redDir, blueDir, detail, matchStart, matchEnd]);

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
    pushLog("[CLEAR] removed automatic detection events");
  }

  // Analyze the paused frame: report candidate counts, centres, matched pixels, and
  // which side of the scoring line each candidate is on. Purely diagnostic.
  function analyzeCurrentFrame() {
    const v = videoRef.current;
    if (!v) return;
    const redCfg = candidateCfgFrom(colorTargetsRef.current, redSensRef.current, RED_COLOR_FLOORS);
    const blueCfg = candidateCfgFrom(colorTargetsRef.current, blueSensRef.current);
    const rs = sampleZone(v, redZone);
    const bs = sampleZone(v, blueZone);
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
    const payload = { diag: diagRef.current, events, redZone, blueZone, redDir, blueDir, colorTargets, redSensitivity, blueSensitivity, redSingleArea, blueSingleArea, redScore, blueScore };
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
        showOverlays
        currentTime={currentTime}
        duration={meta.duration}
        statusLabel={statusLabel}
        videoAspect={videoAspect}
        samplingColor={sampleMode}
        onSample={sampleColorAt}
        redDir={redDir}
        blueDir={blueDir}
      />

      {videoUrl && (
        <>
          {/* Goal calibration + processing controls */}
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-white/45">Goal Calibration &amp; Processing</h3>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setRedZone(DEFAULT_RED_ZONE);
                  setBlueZone(DEFAULT_BLUE_ZONE);
                  setRedSensitivity(DEFAULT_RED_SENSITIVITY);
                  setBlueSensitivity(DEFAULT_BLUE_SENSITIVITY);
                  setRedSingleArea(DEFAULT_RED_SINGLE_AREA);
                  setBlueSingleArea(DEFAULT_BLUE_SINGLE_AREA);
                }}
                className="chip"
              >
                Reset goal zones
              </button>
            </div>

            <p className="mt-4 text-[11px] text-white/40">
              Drag the sliders until the <span style={{ color: "var(--scout-red)" }}>red</span> and{" "}
              <span style={{ color: "var(--scout-blue)" }}>blue</span> boxes sit over each alliance&apos;s goal
              opening. The thin line across each box is the scoring line — position it where artifacts cross into
              the goal. Only these two boxes are analyzed. The detector runs continuously (no match phases).
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ZoneControls label="Red goal zone" color="var(--scout-red)" zone={redZone} onChange={setRedZone} />
              <ZoneControls label="Blue goal zone" color="var(--scout-blue)" zone={blueZone} onChange={setBlueZone} />
            </div>

            {/* Artifact colour calibration — the biggest accuracy lever. */}
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

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {processing !== "analyzing" ? (
                <button
                  type="button"
                  onClick={runAnalysis}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-black"
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
              Experimental color-detection CV runs entirely in your browser over the two goal zones shown on the video.
              Every detection is reviewable below — treat it as an assist, not a referee.
            </p>
          </div>

          {/* Live detection controls */}
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/45">Live Detection</h3>
                <p className="mt-1 text-[11px] text-white/40">
                  Turn on, then press play. Every artifact crossing a gate line scores +3 live (works at 0.25×–2×).
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
                  className="rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide transition"
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
              <span className="text-white/45">RED cand <span className="tabular-nums text-white/80">{diag.red.candidates}</span> · crossings <span className="tabular-nums text-white/80">{diag.red.totalCrossings}</span></span>
              <span className="text-white/45">BLUE cand <span className="tabular-nums text-white/80">{diag.blue.candidates}</span> · crossings <span className="tabular-nums text-white/80">{diag.blue.totalCrossings}</span></span>
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
                onClick={() => {
                  setMatchStart(0);
                  setMatchEnd(null);
                  matchEndedRef.current = false;
                  setMatchComplete(false);
                }}
              >
                Clear
              </button>
              <span className="text-white/50">
                Scoring <span className="font-mono text-white/80">{fmt(matchStart)}</span> →{" "}
                <span className="font-mono text-white/80">{matchEnd != null ? fmt(matchEnd) : "video end"}</span>
                {matchEnd != null && " · auto-stops at buzzer"}
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
                {" · "}scoring stopped at the buzzer{matchEnd != null ? ` (${fmt(matchEnd)})` : ""}
              </p>
            </div>
          )}

          {/* Live scoreboard */}
          <Scoreboard red={redScore} blue={blueScore} latestEvent={latestEvent} />

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
