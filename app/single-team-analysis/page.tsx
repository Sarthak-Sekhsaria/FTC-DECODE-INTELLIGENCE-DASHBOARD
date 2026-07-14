"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const RECENTS_KEY = "sta:recent-teams";

// Accept only a positive whole team number: digits only — no spaces, letters,
// symbols, decimals, or leading sign.
function validate(raw: string): { valid: boolean; message: string | null } {
  const v = raw.trim();
  if (v === "") return { valid: false, message: null };
  if (!/^\d+$/.test(v)) {
    return { valid: false, message: "Team numbers can contain digits only — no spaces, letters, symbols, or decimals." };
  }
  if (Number(v) <= 0) return { valid: false, message: "Please enter a valid positive team number." };
  return { valid: true, message: null };
}

export default function SingleTeamAnalysisPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [recents, setRecents] = useState<number[]>([]);

  const { valid, message } = useMemo(() => validate(value), [value]);
  const isEmpty = value.trim() === "";

  useEffect(() => {
    // Hydration-safe mount read: the server renders no recents, then the client
    // hydrates them from localStorage. An effect is the correct place for this.
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setRecents(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  function submit() {
    setTouched(true);
    if (!validate(value).valid) return;
    router.push(`/single-team-analysis/${Number(value.trim())}`);
  }

  // Inline validation: the empty-field prompt only appears after an attempt;
  // format errors appear as soon as the user has typed something.
  const shownMessage = isEmpty ? (touched ? "Please enter an FTC team number." : null) : message;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-12 md:py-20">
      <Link href="/" className="w-fit text-sm font-medium text-white/50 transition hover:text-white/80">
        ← Back to Dashboard
      </Link>

      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/40">
          FIRST Tech Challenge · DECODE Season
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">
          <span style={{ color: "var(--ftc-blue)" }}>Single Team</span> <span className="text-white">Analysis</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-white/60">
          Enter an FTC team number to begin a detailed analysis of the team&apos;s performance during the FTC DECODE
          2025–2026 season.
        </p>
      </header>

      <div
        className="rounded-2xl border p-6 md:p-7"
        style={{
          borderColor: "var(--panel-border)",
          background: "linear-gradient(160deg, rgba(0,114,206,0.10), rgba(11,18,32,0.25))",
        }}
      >
        <label htmlFor="team" className="block text-sm font-semibold text-white/80">
          FTC Team Number
        </label>
        <input
          id="team"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Enter a team number, for example 12345"
          aria-invalid={shownMessage !== null}
          className="mt-2 w-full rounded-xl border bg-black/25 px-4 py-3 text-lg text-white outline-none transition placeholder:text-white/30"
          style={{ borderColor: shownMessage ? "rgba(239,68,68,0.6)" : "var(--panel-border)" }}
        />

        <div className="mt-2 min-h-[1.25rem]">
          {shownMessage && <p className="text-sm text-red-400">{shownMessage}</p>}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!valid}
          className="mt-3 w-full rounded-xl px-4 py-3 text-base font-bold transition disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: valid ? "var(--ftc-blue)" : "rgba(255,255,255,0.08)", color: valid ? "#fff" : "rgba(255,255,255,0.5)" }}
        >
          Analyze Team
        </button>

        {recents.length > 0 && (
          <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--panel-border)" }}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Recent</p>
            <div className="flex flex-wrap gap-2">
              {recents.map((n) => (
                <Link key={n} href={`/single-team-analysis/${n}`} className="chip">
                  #{n}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="text-center text-xs text-white/35">
        Analysis uses verified FTCScout data from the DECODE 2025–2026 season only.
      </p>
    </main>
  );
}
