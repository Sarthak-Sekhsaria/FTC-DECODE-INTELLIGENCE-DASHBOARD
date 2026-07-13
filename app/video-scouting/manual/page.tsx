"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ProgressDots from "../components/ProgressDots";
import VideoPanel from "../components/VideoPanel";
import TeamSelectPhase from "../components/TeamSelectPhase";
import AutonomousPhase from "../components/AutonomousPhase";
import TeleopPhase from "../components/TeleopPhase";
import EndgamePhase from "../components/EndgamePhase";
import {
  emptyAutonomousStats,
  emptyTeleopStats,
  emptyEndgameStats,
  type Alliance,
  type StartPosition,
  type ScoutingSession,
} from "@/lib/scouting/types";

export default function ManualScoutingPage() {
  const router = useRouter();

  const [phase, setPhase] = useState(0);
  const [teamNumber, setTeamNumber] = useState("");
  const [alliance, setAlliance] = useState<Alliance | null>(null);
  const [startPosition, setStartPosition] = useState<StartPosition | null>(null);
  const [autonomous, setAutonomous] = useState(emptyAutonomousStats());
  const [teleop, setTeleop] = useState(emptyTeleopStats());
  const [endgame, setEndgame] = useState(emptyEndgameStats());
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  // The uploaded video is a local object URL. Revoke the previous one whenever it
  // changes (new upload, reset, or navigating away) to avoid leaking memory — this
  // is the only cleanup needed since the file itself is never sent to the server.
  useEffect(() => {
    if (!videoUrl) return;
    return () => URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  function handleVideoUpload(file: File) {
    setVideoUrl(URL.createObjectURL(file));
  }

  function resetSession() {
    if (phase === 0 && teamNumber === "" && alliance === null) return;
    if (!window.confirm("Reset this scouting session? All entered data will be lost.")) return;
    setPhase(0);
    setTeamNumber("");
    setAlliance(null);
    setStartPosition(null);
    setAutonomous(emptyAutonomousStats());
    setTeleop(emptyTeleopStats());
    setEndgame(emptyEndgameStats());
    setError(null);
    setVideoUrl(null);
  }

  async function handleCommit() {
    setCommitting(true);
    setError(null);
    try {
      const session: ScoutingSession = {
        teamNumber: Number(teamNumber),
        alliance: alliance as Alliance,
        startPosition: startPosition as StartPosition,
        autonomous,
        teleop,
        endgame,
      };
      const res = await fetch("/api/scouting/generate-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate the team description.");
      sessionStorage.setItem("scouting_result", JSON.stringify(data));
      router.push("/video-scouting/result");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  // The video panel only moves into a sticky side column after Team Select —
  // that first phase's layout (and everything on it) stays exactly as it was.
  const sideVideoLayout = phase !== 0;

  return (
    <main
      className={`scouting-layout flex-1 px-4 py-8 ${sideVideoLayout ? "scouting-layout--sidevideo" : ""}`}
      style={{ background: "var(--scout-bg)" }}
    >
      <div className="scouting-header flex items-center justify-between">
        <Link href="/video-scouting" className="text-sm font-medium text-white/40 transition hover:text-white/70">
          ← Scouting Modes
        </Link>
        <div className="text-right">
          <p className="text-sm font-black tracking-wide text-white">Manual Scouting</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--scout-accent)" }}>
            DECODE Scouting
          </p>
        </div>
      </div>

      <div className="scouting-progress">
        <ProgressDots currentPhase={phase} onReset={resetSession} />
      </div>

      {/* Same element/DOM position for every phase (only its CSS grid area
          changes) — the <video> inside never unmounts, so playback position
          and play/pause state carry over as the user moves between phases. */}
      <div className="scouting-video-slot">
        <VideoPanel videoUrl={videoUrl} onUpload={handleVideoUpload} allowUpload={phase === 0} />
      </div>

      <div className="scouting-error">
        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>

      <div className="scouting-content flex flex-col gap-5">
        {phase === 0 && (
          <TeamSelectPhase
            teamNumber={teamNumber}
            alliance={alliance}
            startPosition={startPosition}
            onTeamNumberChange={setTeamNumber}
            onAllianceChange={setAlliance}
            onStartPositionChange={setStartPosition}
            onInitialize={() => setPhase(1)}
          />
        )}

        {phase === 1 && (
          <AutonomousPhase
            stats={autonomous}
            onArtifact={() =>
              setAutonomous((s) => {
                const artifacts = s.artifacts + 1;
                return { ...s, artifacts, score: artifacts * 3 + s.pattern * 2 };
              })
            }
            onPattern={() =>
              setAutonomous((s) => {
                const pattern = s.pattern + 1;
                return { ...s, pattern, score: s.artifacts * 3 + pattern * 2 };
              })
            }
            onGate={() => setAutonomous((s) => ({ ...s, gate: s.gate + 1 }))}
            onBack={() => setPhase(0)}
            onNext={() => setPhase(2)}
          />
        )}

        {phase === 2 && (
          <TeleopPhase
            stats={teleop}
            onArtifact={() =>
              setTeleop((s) => {
                const artifacts = s.artifacts + 1;
                return { ...s, artifacts, score: artifacts * 3 };
              })
            }
            onHumanPlayer1={() => setTeleop((s) => ({ ...s, humanPlayer1: s.humanPlayer1 + 1 }))}
            onHumanPlayer2={() => setTeleop((s) => ({ ...s, humanPlayer2: s.humanPlayer2 + 1 }))}
            onBack={() => setPhase(1)}
            onNext={() => setPhase(3)}
          />
        )}

        {phase === 3 && (
          <EndgamePhase
            stats={endgame}
            onChange={setEndgame}
            onBack={() => setPhase(2)}
            onCommit={handleCommit}
            committing={committing}
          />
        )}
      </div>
    </main>
  );
}
