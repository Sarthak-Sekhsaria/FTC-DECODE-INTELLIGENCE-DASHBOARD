import Link from "next/link";

function ToolCard({
  href,
  title,
  description,
  accent,
  cta = "Open",
}: {
  href: string;
  title: string;
  description: string;
  accent: "red" | "blue" | "cyan";
  cta?: string;
}) {
  const color = accent === "red" ? "var(--ftc-red)" : accent === "cyan" ? "#38bdf8" : "var(--ftc-blue)";
  const glow =
    accent === "red"
      ? "linear-gradient(160deg, rgba(228,0,43,0.16), rgba(228,0,43,0.02))"
      : accent === "cyan"
        ? "linear-gradient(160deg, rgba(56,189,248,0.16), rgba(56,189,248,0.02))"
        : "linear-gradient(160deg, rgba(0,114,206,0.16), rgba(0,114,206,0.02))";
  const borderDim = accent === "red" ? "var(--ftc-red-dim)" : accent === "cyan" ? "#0e4d63" : "var(--ftc-blue-dim)";

  return (
    <Link
      href={href}
      className="group flex flex-col justify-between rounded-2xl border p-7 transition hover:-translate-y-1 hover:shadow-2xl"
      style={{ borderColor: borderDim, background: glow }}
    >
      <div>
        <h2 className="text-xl font-bold" style={{ color }}>
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/65">{description}</p>
      </div>
      <span
        className="mt-6 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-white/80 transition group-hover:gap-2.5"
        style={{ color }}
      >
        {cta} <span aria-hidden>→</span>
      </span>
    </Link>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 py-16 md:py-24">
      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/40">
          FIRST Tech Challenge
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          <span style={{ color: "var(--ftc-red)" }}>FTC</span>{" "}
          <span className="text-white">Match Intelligence</span>{" "}
          <span style={{ color: "var(--ftc-blue)" }}>Dashboard</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-white/60">
          A growing toolkit for FTC analysis, prediction, and scouting. Pick a tool below to get
          started.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <ToolCard
          href="/predict"
          title="Prediction AI"
          description="Predict the winner of a DECODE match from four team numbers, backed by live FTCScout research and AI analysis."
          accent="red"
        />
        <ToolCard
          href="/video-scouting"
          title="Video Scouting"
          description="Break down match film to scout robot capabilities, tendencies, and performance trends."
          accent="blue"
        />
        <ToolCard
          href="/single-team-analysis"
          title="Single Team Analysis"
          description="Enter an FTC team number to generate a detailed DECODE-season report covering performance, strengths, weaknesses, consistency, strategy, and counterplay."
          accent="cyan"
          cta="Analyze a Team"
        />
      </div>
    </main>
  );
}
