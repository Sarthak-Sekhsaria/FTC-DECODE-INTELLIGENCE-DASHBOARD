"use client";

import { useState } from "react";
import type { AllianceColor, ScoreEvent } from "@/lib/scouting/autoTypes";

export type EventFilter = "all" | "red" | "blue" | "auto" | "manual" | "low" | "corrected";

const FILTERS: { key: EventFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "red", label: "Red" },
  { key: "blue", label: "Blue" },
  { key: "auto", label: "Detected" },
  { key: "manual", label: "Manual" },
  { key: "low", label: "Low conf." },
  { key: "corrected", label: "Corrected" },
];

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

function matchesFilter(e: ScoreEvent, f: EventFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "red":
      return e.alliance === "red";
    case "blue":
      return e.alliance === "blue";
    case "auto":
      return e.method === "cv";
    case "manual":
      return e.method === "manual";
    case "low":
      return e.confidence === "low" || e.status === "auto";
    case "corrected":
      return e.status === "confirmed" || e.status === "rejected" || e.method === "manual";
  }
}

const CONF_COLOR: Record<string, string> = {
  high: "var(--scout-accent)",
  medium: "#f59e0b",
  low: "#ef4444",
};

export default function EventList({
  events,
  onUpdate,
  onAddMissed,
  onSeek,
}: {
  events: ScoreEvent[];
  onUpdate: (id: string, patch: Partial<ScoreEvent>) => void;
  onAddMissed: (alliance: AllianceColor) => void;
  onSeek: (t: number) => void;
}) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const visible = events.filter((e) => matchesFilter(e, filter)).sort((a, b) => a.videoTime - b.videoTime);

  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--scout-border)", background: "var(--scout-panel)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-white/45">
          Event Timeline ({events.filter((e) => e.status !== "rejected").length})
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onAddMissed("red")}
            className="rounded-lg border px-2.5 py-1 text-xs font-bold"
            style={{ borderColor: "var(--scout-red)", color: "var(--scout-red)" }}
          >
            + Red
          </button>
          <button
            type="button"
            onClick={() => onAddMissed("blue")}
            className="rounded-lg border px-2.5 py-1 text-xs font-bold"
            style={{ borderColor: "var(--scout-blue)", color: "var(--scout-blue)" }}
          >
            + Blue
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold transition"
            style={
              filter === f.key
                ? { background: "var(--scout-accent)", color: "#04140c" }
                : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.55)" }
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-white/35">No events match this filter.</p>
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {visible.map((e) => {
            const accent = e.alliance === "red" ? "var(--scout-red)" : "var(--scout-blue)";
            const rejected = e.status === "rejected";
            return (
              <li
                key={e.id}
                className="rounded-xl border border-white/10 bg-black/20 p-3"
                style={{ opacity: rejected ? 0.45 : 1 }}
              >
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => onSeek(e.videoTime)}
                    className="font-mono text-white/50 underline-offset-2 hover:text-white/90 hover:underline"
                    title="Seek video to just before this detection"
                  >
                    {fmtTime(e.videoTime)}
                  </button>
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: `${accent}22`, color: accent }}>
                    {e.alliance}
                  </span>
                  <span className="font-semibold text-white/80">
                    {e.type} +{e.points}
                  </span>
                  <span className="text-[10px] uppercase text-white/35">{e.method === "cv" ? "auto" : "manual"}</span>
                  <span className="ml-auto text-[10px] font-bold uppercase" style={{ color: CONF_COLOR[e.confidence] }}>
                    {e.method === "manual" ? "manual" : `${e.status === "auto" ? "auto·" : ""}${e.confidence}`}
                  </span>
                </div>
                {e.note && <p className="mt-1 text-[10px] text-amber-300/70">{e.note}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {rejected ? (
                    <button type="button" onClick={() => onUpdate(e.id, { status: "confirmed" })} className="chip">
                      Undo reject
                    </button>
                  ) : (
                    <>
                      {e.status !== "confirmed" && (
                        <button type="button" onClick={() => onUpdate(e.id, { status: "confirmed" })} className="chip">
                          Confirm
                        </button>
                      )}
                      <button type="button" onClick={() => onUpdate(e.id, { status: "rejected" })} className="chip">
                        Reject
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdate(e.id, { alliance: e.alliance === "red" ? "blue" : "red" })}
                        className="chip"
                      >
                        Swap alliance
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdate(e.id, { type: e.type === "classified" ? "overflow" : "classified" })}
                        className="chip"
                      >
                        Mark {e.type === "classified" ? "overflow" : "classified"}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
