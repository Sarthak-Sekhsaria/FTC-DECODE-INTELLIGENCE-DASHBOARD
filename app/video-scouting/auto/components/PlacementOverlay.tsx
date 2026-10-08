"use client";

// Drawn on top of the video (same aspect-ratio box, native-pixel viewBox):
//  - the projected RAMP ROI quads from automatic placement (alliance colour, or
//    amber when confidence is low)
//  - the guided 4-tap flow (method C): click capture, numbered taps, a mini field
//    diagram highlighting the next corner, Undo / Cancel
//  - the placement debug layer: detected AprilTags + IDs, detected grid lines and
//    intersections, the WHOLE field model reprojected with the solved pose, the
//    final ROIs, and method / reprojection error / FOV text.
//  - the RAMP slots the counter samples (debug mode), following the camera, filled when the
//    slot looks like it holds an ARTIFACT, hollow when it looks empty, dashed when unclear.

import type { FieldModel } from "@/lib/scouting/placement/fieldModel";
import { projectSegment, type Intrinsics, type Pose, type Vec2, type Vec3 } from "@/lib/scouting/placement/geometry";
import type { TagDetection } from "@/lib/scouting/placement/apriltag";
import type { FieldPlaneDebug } from "@/lib/scouting/placement/fieldPlane";
import type { LaneView } from "@/lib/scouting/rampScorer";

export interface OverlayRoi {
  alliance: "red" | "blue";
  quad: Vec2[]; // normalized
}

export interface OverlayDebug {
  method: string;
  reprojError: number | null;
  fovDeg: number | null;
  pose: Pose | null;
  intrinsics: Intrinsics | null;
  tags?: TagDetection[];
  fieldPlane?: FieldPlaneDebug;
  correspondences?: { image: Vec2; world: Vec3 }[];
}

const RED = "#ef4444";
const BLUE = "#3b82f6";
const WARN = "#f59e0b";

// Tap order = field_model perimeterCorners order: red-goal corner first, then
// clockwise seen from above. In the mini diagram the audience is at the bottom
// (CM Fig 9-18), so that is top-right, bottom-right, bottom-left, top-left.
const DIAGRAM_CORNERS: Vec2[] = [
  [92, 8],
  [92, 92],
  [8, 92],
  [8, 8],
];

function FieldDiagram({ next, labels }: { next: number; labels: string[] }) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20 rounded-lg border border-white/20 bg-black/80 p-2 text-[10px] text-white/70">
      <svg viewBox="-6 -6 112 118" className="h-28 w-28">
        <rect x="0" y="0" width="100" height="100" fill="#2a2f33" stroke="#9aa39d" strokeWidth="1.5" />
        {/* GOALS in the far corners (CM Fig 9-18): blue far-left, red far-right */}
        <polygon points="0,0 22,0 0,22" fill={BLUE} />
        <polygon points="100,0 78,0 100,22" fill={RED} />
        {/* ALLIANCE AREAS (CM §9.5: red on the left from the audience) */}
        <rect x="-6" y="30" width="5" height="70" fill={RED} opacity="0.6" />
        <rect x="101" y="30" width="5" height="70" fill={BLUE} opacity="0.6" />
        <text x="50" y="112" textAnchor="middle" fill="#9aa39d" fontSize="8">audience</text>
        {DIAGRAM_CORNERS.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={i === next ? 7 : 5} fill={i < next ? "#22ffa0" : i === next ? "#fff" : "#555"} stroke="#000" strokeWidth="1" />
            <text x={x} y={y + 3} textAnchor="middle" fontSize="8" fontWeight="700" fill="#000">{i + 1}</text>
          </g>
        ))}
      </svg>
      <p className="mt-1 max-w-28 leading-tight">{next < 4 ? labels[next] : "All 4 tapped"}</p>
    </div>
  );
}

function projPoly(pts: Vec3[], pose: Pose, K: Intrinsics): string[] {
  const segs: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const s = projectSegment(pts[i], pts[(i + 1) % pts.length], pose, K);
    if (s) segs.push(`M${s[0][0]},${s[0][1]}L${s[1][0]},${s[1][1]}`);
  }
  return segs;
}

function ModelReprojection({ model, pose, K }: { model: FieldModel; pose: Pose; K: Intrinsics }) {
  const d: string[] = [];
  const X = model.gridLinesX;
  const Y = model.gridLinesY;
  // Perimeter + TILE grid on the floor.
  d.push(...projPoly(model.perimeterCorners.map((c) => c.point), pose, K));
  for (const x of model.seamsX) {
    const s = projectSegment([x, Y[0], 0], [x, Y[Y.length - 1], 0], pose, K);
    if (s) d.push(`M${s[0][0]},${s[0][1]}L${s[1][0]},${s[1][1]}`);
  }
  for (const y of model.seamsY) {
    const s = projectSegment([X[0], y, 0], [X[X.length - 1], y, 0], pose, K);
    if (s) d.push(`M${s[0][0]},${s[0][1]}L${s[1][0]},${s[1][1]}`);
  }
  // Perimeter wall tops.
  const top = model.perimeterCorners.map((c) => [c.point[0], c.point[1], model.wallTopZ] as Vec3);
  const wall = projPoly(top, pose, K);
  // The ALLIANCE-coloured panels (GOAL + lower-RAMP blocker) that method B matches to the
  // red / blue regions, and the floor tape it matches to the tape pixels.
  const goals = model.goals.map((g) => ({
    alliance: g.alliance,
    d: [...g.panels.body, g.panels.blocker].flatMap((p) => projPoly(p, pose, K)),
  }));
  const tape = (["white", "red", "blue"] as const).map((colour) => ({
    colour,
    d: model.markings
      .filter((m) => m.colour === colour)
      .flatMap((m) => {
        const pts = m.closed ? [...m.points, m.points[0]] : m.points;
        const out: string[] = [];
        for (let i = 0; i + 1 < pts.length; i++) {
          const s = projectSegment(pts[i], pts[i + 1], pose, K);
          if (s) out.push(`M${s[0][0]},${s[0][1]}L${s[1][0]},${s[1][1]}`);
        }
        return out;
      }),
  }));
  const tags = model.tags.map((t) => ({ id: t.id, d: projPoly(t.corners, pose, K) }));
  const ramps = model.ramps.map((r) => ({ alliance: r.alliance, d: projPoly(r.surfaceCorners, pose, K) }));
  return (
    <g fill="none">
      <path d={d.join("")} stroke="#22ffa0" strokeWidth={Math.max(1, K.width / 900)} opacity={0.75} />
      <path d={wall.join("")} stroke="#22ffa0" strokeWidth={Math.max(1, K.width / 1200)} strokeDasharray="6 4" opacity={0.5} />
      {tape.map((t) => (
        <path key={t.colour} d={t.d.join("")} stroke={t.colour === "white" ? "#e879f9" : t.colour === "red" ? "#fb7185" : "#60a5fa"} strokeWidth={Math.max(1, K.width / 1200)} opacity={0.9} />
      ))}
      {goals.map((g) => (
        <path key={g.alliance} d={g.d.join("")} stroke={g.alliance === "red" ? "#ff8a8a" : "#8ab4ff"} strokeWidth={Math.max(1, K.width / 900)} />
      ))}
      {tags.map((t) => (
        <path key={t.id} d={t.d.join("")} stroke="#fde047" strokeWidth={Math.max(1, K.width / 900)} />
      ))}
      {ramps.map((r) => (
        <path key={r.alliance} d={r.d.join("")} stroke="#fff" strokeWidth={Math.max(1, K.width / 700)} strokeDasharray="3 3" />
      ))}
    </g>
  );
}

export default function PlacementOverlay({
  width,
  height,
  rois,
  lowConfidence,
  label,
  tapping,
  onTap,
  onUndoTap,
  onCancelTaps,
  tapLabels,
  debug,
  model,
  lanes,
}: {
  width: number;
  height: number;
  rois: OverlayRoi[];
  lowConfidence: boolean;
  label: string | null;
  tapping: Vec2[] | null; // native px taps so far, or null when not tapping
  onTap: (nx: number, ny: number) => void;
  onUndoTap: () => void;
  onCancelTaps: () => void;
  tapLabels: string[];
  debug: OverlayDebug | null;
  model: FieldModel | null;
  lanes?: LaneView[];
}) {
  if (!width || !height) return null;
  const sw = Math.max(1.5, width / 500);
  const font = Math.max(12, width / 60);
  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {debug && model && debug.pose && debug.intrinsics && <ModelReprojection model={model} pose={debug.pose} K={debug.intrinsics} />}

        {debug?.fieldPlane && (
          <g>
            {debug.fieldPlane.lines.map((l, i) => (
              <line key={i} x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke={["#f472b6", "#38bdf8", "#a3e635", "#fb923c"][l.family % 4]} strokeWidth={sw * 0.6} opacity={0.7} />
            ))}
            {debug.fieldPlane.intersections.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={sw * 1.4} fill="#fff" opacity={0.8} />
            ))}
            {debug.fieldPlane.floorHull.length > 2 && (
              <polygon points={debug.fieldPlane.floorHull.map((p) => p.join(",")).join(" ")} fill="none" stroke="#94a3b8" strokeWidth={sw * 0.6} strokeDasharray="8 6" />
            )}
          </g>
        )}
        {debug?.correspondences?.map((c, i) => (
          <circle key={i} cx={c.image[0]} cy={c.image[1]} r={sw * 2.2} fill="none" stroke="#22ffa0" strokeWidth={sw * 0.8} />
        ))}
        {debug?.tags?.map((t) => (
          <g key={t.id}>
            <polygon points={t.corners.map((p) => p.join(",")).join(" ")} fill="none" stroke={t.id === 20 || t.id === 24 ? "#fde047" : "#94a3b8"} strokeWidth={sw} />
            <text x={t.corners[0][0]} y={t.corners[0][1] - sw * 3} fill="#fde047" fontSize={font} fontWeight={800} stroke="#000" strokeWidth={font / 8} paintOrder="stroke">
              ID {t.id}
            </text>
          </g>
        ))}

        {rois.map((r) => {
          const color = lowConfidence ? WARN : r.alliance === "red" ? RED : BLUE;
          const pts = r.quad.map(([x, y]) => [x * width, y * height]);
          return (
            <g key={r.alliance}>
              <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={sw * 1.4} strokeLinejoin="round" />
              <text x={pts[0][0]} y={pts[0][1] - sw * 3} fill={color} fontSize={font} fontWeight={800} stroke="#000" strokeWidth={font / 8} paintOrder="stroke">
                {r.alliance.toUpperCase()} RAMP
              </text>
            </g>
          );
        })}

        {lanes?.map((l) =>
          l.slots.map((s, k) => {
            const colour = l.alliance === "red" ? RED : BLUE;
            const ball = s.llr > 0.5, empty = s.llr < -0.5;
            return (
              <circle
                key={`${l.alliance}${k}`}
                cx={s.c[0]}
                cy={s.c[1]}
                r={Math.max(sw, s.r)}
                fill={ball ? colour : "none"}
                fillOpacity={0.55}
                stroke={l.tracked ? (ball ? colour : "#fff") : WARN}
                strokeWidth={sw * 0.7}
                strokeDasharray={ball || empty ? undefined : `${sw * 1.5} ${sw}`}
                opacity={0.9}
              />
            );
          }),
        )}

        {tapping?.map((p, i) => (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r={sw * 4} fill="#22ffa0" stroke="#000" strokeWidth={sw} />
            <text x={p[0]} y={p[1] + font * 0.35} textAnchor="middle" fontSize={font} fontWeight={800} fill="#000">{i + 1}</text>
          </g>
        ))}

        {(debug || label) && (
          <text x={sw * 5} y={height - sw * 6} fill="#fff" fontSize={font} fontWeight={700} stroke="#000" strokeWidth={font / 7} paintOrder="stroke">
            {debug
              ? `Method ${debug.method} · reproj ${debug.reprojError == null ? "—" : `${debug.reprojError.toFixed(2)} px`} · FOV ${debug.fovDeg == null ? "—" : `${debug.fovDeg.toFixed(1)}°`}`
              : label}
          </text>
        )}
      </svg>

      {tapping && (
        <>
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            style={{ background: "rgba(0,0,0,0.15)" }}
            onClick={(e) => {
              if (tapping.length >= 4) return;
              const r = e.currentTarget.getBoundingClientRect();
              onTap(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
            }}
          />
          <FieldDiagram next={tapping.length} labels={tapLabels} />
          <div className="absolute left-2 top-2 z-20 flex flex-col gap-1.5 rounded-lg bg-black/80 px-3 py-2 text-xs text-white">
            <span className="font-bold">Tap the 4 field corners.</span>
            <span className="text-white/60">Where the floor meets the wall — estimate it if a GOAL hides the corner.</span>
            <div className="flex gap-1.5">
              <button type="button" className="chip" onClick={onUndoTap} disabled={!tapping.length}>
                Undo tap
              </button>
              <button type="button" className="chip" onClick={onCancelTaps}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
