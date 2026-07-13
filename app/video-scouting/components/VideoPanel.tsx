"use client";

import { useRef, useState } from "react";
import PhaseCard from "./PhaseCard";

const SKIP_SECONDS = 10;
const FILE_INPUT_ID = "scouting-video-upload";

function UploadIcon() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export default function VideoPanel({
  videoUrl,
  onUpload,
  allowUpload,
}: {
  videoUrl: string | null;
  onUpload: (file: File) => void;
  allowUpload: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dismissed, setDismissed] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
    // Reset so selecting the same filename again still fires onChange.
    e.target.value = "";
  }

  function skip(deltaSeconds: number) {
    const el = videoRef.current;
    if (!el) return;
    const duration = Number.isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = Math.min(Math.max(0, el.currentTime + deltaSeconds), duration);
  }

  if (videoUrl) {
    return (
      <PhaseCard title="Match Video">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
          <div className="aspect-video w-full">
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              className="h-full w-full object-contain"
            />
          </div>
        </div>
        <div className="mt-3 flex gap-3">
          <button
            type="button"
            onClick={() => skip(-SKIP_SECONDS)}
            className="flex-1 rounded-lg border border-white/15 py-2.5 text-sm font-bold text-white/70 transition hover:border-white/30 hover:text-white"
          >
            « {SKIP_SECONDS}s
          </button>
          <button
            type="button"
            onClick={() => skip(SKIP_SECONDS)}
            className="flex-1 rounded-lg border border-white/15 py-2.5 text-sm font-bold text-white/70 transition hover:border-white/30 hover:text-white"
          >
            {SKIP_SECONDS}s »
          </button>
        </div>
      </PhaseCard>
    );
  }

  if (allowUpload) {
    return (
      <div>
        <input
          id={FILE_INPUT_ID}
          type="file"
          accept="video/*"
          onChange={handleFileChange}
          className="hidden"
        />
        <label
          htmlFor={FILE_INPUT_ID}
          className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition hover:bg-white/[0.03]"
          style={{ borderColor: "var(--scout-border)" }}
        >
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: "var(--scout-accent-dim)", color: "var(--scout-accent)" }}
          >
            <UploadIcon />
          </span>
          <span className="text-base font-bold text-white/80">Upload Match Video</span>
          <span className="text-xs text-white/40">Tap to choose a video from your device</span>
        </label>
      </div>
    );
  }

  if (dismissed) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="text-sm text-white/55">
        No video uploaded. Go back to Team Selection to upload match footage.
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/50 transition hover:border-white/30 hover:text-white/80"
      >
        ×
      </button>
    </div>
  );
}
