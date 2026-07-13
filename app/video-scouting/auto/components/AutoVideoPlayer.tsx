"use client";

import { useRef, useState, type RefObject } from "react";

export interface Zone {
  x: number; // normalized 0..1 (left)
  y: number; // normalized 0..1 (top)
  w: number; // normalized 0..1
  h: number; // normalized 0..1
  line: number; // crossing line within the zone height, 0..1
}

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

function fmt(t: number): string {
  if (!Number.isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ZoneOverlay({
  zone,
  color,
  label,
  direction,
}: {
  zone: Zone;
  color: string;
  label: string;
  direction: "downward" | "upward";
}) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${zone.x * 100}%`,
        top: `${zone.y * 100}%`,
        width: `${zone.w * 100}%`,
        height: `${zone.h * 100}%`,
        border: `2px solid ${color}`,
        boxShadow: `0 0 0 1px rgba(0,0,0,0.4)`,
        borderRadius: 4,
      }}
    >
      <span
        className="absolute -top-5 left-0 rounded px-1 text-[10px] font-bold uppercase"
        style={{ background: color, color: "#04140c" }}
      >
        {label} {direction === "downward" ? "↓" : "↑"}
      </span>
      {/* scoring line + a direction arrow showing which way across it counts */}
      <div
        className="absolute left-0 w-full"
        style={{ top: `${zone.line * 100}%`, height: 2, background: color, opacity: 0.9 }}
      />
      <span
        className="absolute right-0 text-xs font-black"
        style={{ top: `${zone.line * 100}%`, transform: "translateY(-50%)", color }}
      >
        {direction === "downward" ? "▼" : "▲"}
      </span>
    </div>
  );
}

export default function AutoVideoPlayer({
  videoUrl,
  videoRef,
  onUpload,
  redZone,
  blueZone,
  showOverlays,
  currentTime,
  duration,
  statusLabel,
  videoAspect,
  samplingColor,
  onSample,
  redDir,
  blueDir,
}: {
  videoUrl: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onUpload: (file: File) => void;
  redZone: Zone;
  blueZone: Zone;
  showOverlays: boolean;
  currentTime: number;
  duration: number;
  statusLabel: string;
  videoAspect: number; // width / height of the actual video, 0 until known
  samplingColor: "purple" | "green" | null;
  onSample: (nx: number, ny: number) => void;
  redDir: "downward" | "upward";
  blueDir: "downward" | "upward";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setError(`"${file.name}" is not a video file.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(0)} MB — over the 500 MB limit.`);
      return;
    }
    onUpload(file);
  }

  if (!videoUrl) {
    return (
      <div>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            accept(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            accept(e.dataTransfer.files?.[0]);
          }}
          onClick={() => inputRef.current?.click()}
          className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition"
          style={{
            borderColor: dragOver ? "var(--scout-accent)" : "var(--scout-border)",
            background: dragOver ? "rgba(34,255,160,0.06)" : "transparent",
          }}
        >
          <span
            className="flex h-16 w-16 items-center justify-center rounded-full text-2xl"
            style={{ background: "var(--scout-accent-dim)", color: "var(--scout-accent)" }}
          >
            ↑
          </span>
          <span className="text-lg font-bold text-white/80">Upload Match Video</span>
          <span className="text-xs text-white/40">Drag &amp; drop or click to choose · accepts any video · max 500 MB</span>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black">
        {/* Container matches the real video aspect ratio so object-contain does not
            letterbox — this keeps the zone overlays aligned pixel-for-pixel with the
            same normalized region the CV samples from the frame. */}
        <div className="relative mx-auto w-full" style={{ aspectRatio: videoAspect > 0 ? videoAspect : 16 / 9 }}>
          <video ref={videoRef} src={videoUrl} controls playsInline className="h-full w-full object-contain" />
          {showOverlays && (
            <>
              <ZoneOverlay zone={redZone} color="var(--scout-red)" label="Red goal" direction={redDir} />
              <ZoneOverlay zone={blueZone} color="var(--scout-blue)" label="Blue goal" direction={blueDir} />
            </>
          )}
          {samplingColor && (
            <div
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
                onSample(nx, ny);
              }}
              className="absolute inset-0 z-10 cursor-crosshair"
              style={{ background: "rgba(0,0,0,0.25)" }}
            >
              <span
                className="absolute left-2 top-2 rounded px-2 py-1 text-xs font-bold"
                style={{
                  background: samplingColor === "purple" ? "#a855f7" : "#26d94a",
                  color: "#04140c",
                }}
              >
                Click a {samplingColor} artifact in the frame
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-white/10 bg-black/30 px-4 py-2 text-xs">
        <span className="text-white/50">
          Time <span className="font-mono text-white">{fmt(currentTime)}</span> / {fmt(duration)}
        </span>
        <span className="ml-auto text-white/50">
          Status <span className="text-white">{statusLabel}</span>
        </span>
      </div>
    </div>
  );
}
