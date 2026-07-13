import Link from "next/link";

function ModeCard({
  href,
  title,
  tag,
  description,
  points,
}: {
  href: string;
  title: string;
  tag: string;
  description: string;
  points: string[];
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-2xl border p-7 transition hover:-translate-y-1 hover:shadow-2xl"
      style={{
        borderColor: "var(--scout-border)",
        background: "linear-gradient(160deg, rgba(34,255,160,0.10), rgba(34,255,160,0.01))",
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-2xl font-black text-white">{title}</h2>
        <span
          className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: "var(--scout-accent-dim)", color: "var(--scout-accent)" }}
        >
          {tag}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-white/65">{description}</p>
      <ul className="mt-4 flex flex-col gap-1.5">
        {points.map((p) => (
          <li key={p} className="flex gap-2 text-sm text-white/70">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--scout-accent)" }} />
            {p}
          </li>
        ))}
      </ul>
      <span
        className="mt-6 inline-flex w-fit items-center gap-1.5 text-sm font-bold uppercase tracking-wide transition group-hover:gap-2.5"
        style={{ color: "var(--scout-accent)" }}
      >
        Open <span aria-hidden>→</span>
      </span>
    </Link>
  );
}

export default function VideoScoutingModePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 py-16 md:py-24">
      <header className="text-center">
        <Link
          href="/"
          className="mb-4 inline-block text-sm font-medium text-white/40 transition hover:text-white/70"
        >
          ← Dashboard
        </Link>
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/40">
          FIRST Tech Challenge · DECODE
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          <span className="text-white">Video</span>{" "}
          <span style={{ color: "var(--scout-accent)" }}>Scouting</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-white/60">
          Choose how you want to scout a match from film.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <ModeCard
          href="/video-scouting/auto"
          title="Auto Scouting"
          tag="Experimental"
          description="Upload a full DECODE match video and let experimental computer vision track artifact scoring for both alliances as it plays — with full manual review and correction."
          points={[
            "Large match-video player with live RED/BLUE scoreboard",
            "Browser color-detection of scored artifacts",
            "Manual pattern & endgame entry, event review",
          ]}
        />
        <ModeCard
          href="/video-scouting/manual"
          title="Manual Scouting"
          tag="Single Team"
          description="Scout one team phase-by-phase while watching the match, then generate a structured AI scouting report backed by live FTCScout data."
          points={[
            "Team-by-team auto / teleop / endgame tracking",
            "Side-panel video while you score",
            "AI scouting report saved to Team_Descriptions",
          ]}
        />
      </div>
    </main>
  );
}
