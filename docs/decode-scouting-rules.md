# DECODE Auto Scouting — Rules & Scoring Reference

Source of truth for the Auto Scouting feature's scoring. All values live in code in
[`lib/scouting/decodeRules.ts`](../lib/scouting/decodeRules.ts) (`DECODE_RULES`); this
document explains where they come from.

## Manual version used

- **Competition Manual:** 2025-2026 FIRST® Tech Challenge, **Section 10 "Game Details"**, version **V9**.
- **Team Update reference:** 32.
- **Retrieved from:** the official FIRST resources site (`ftc-resources.firstinspires.org/ftc/game/manual-10`).

## Match timing — FIRST Championship / Worlds (Manual §10.4 + §15.2.2)

Phase timing is set to the **FIRST Championship (Worlds)** values.

| Period | Length | Notes |
|---|---|---|
| Autonomous (AUTO) | 30 s | Robots run without driver control. |
| AUTO → TELEOP transition | **15 s** | **§15.2.2: at the FIRST Championship the transition is 15 s** (it is 8 s at all other events). |
| TeleOp (TELEOP) | 120 s (2:00) | Driver-controlled. |
| Endgame | — | **DECODE has no separate endgame clock.** BASE is assessed at the end of TELEOP (§10.5 F). The app treats the final ~30 s of TELEOP as "endgame" purely to place the manual endgame-entry panel. |

## Scoring values (Manual Table 10-2)

| Achievement | Points | When assessed |
|---|---|---|
| LEAVE (per robot) | 3 | End of AUTO (§10.5 E) |
| CLASSIFIED artifact | 3 | Throughout match (§10.5 A) |
| OVERFLOW artifact | 1 | Throughout match |
| DEPOT artifact | 1 | End of TELEOP |
| PATTERN — each RAMP artifact matching the MOTIF | 2 | End of AUTO and end of TELEOP (§10.5 B/C) |
| BASE — partially returned (per robot) | 5 | End of TELEOP |
| BASE — fully returned (per robot) | 10 | End of TELEOP |
| BASE — bonus, both robots fully returned | 10 | End of TELEOP |

### ⚠️ Discrepancy with the feature prompt

The Auto Scouting prompt stated overflow artifacts are worth **3** points. The official
manual (Table 10-2) lists **OVERFLOW = 1**. The prompt also states that official FIRST
sources are the source of truth over its own assumptions, so this app uses the **official
value (1)**. It is a single config constant (`points.artifactOverflow`) if a Team Update
ever changes it.

## Pattern assessment (Manual §10.5.2)

- The OBELISK randomization selects one **MOTIF** — one of `GPP`, `PGP`, `PPG` (Figure 10-4).
- The MOTIF repeats 3× across the 9 RAMP indices, defining the target colors.
- A RAMP artifact scores PATTERN points (2 each) when its color matches the MOTIF color at
  its index **and** the artifacts are retained by the GATE.
- Assessed at the AUTO boundary (auto pattern) and again at match end (teleop pattern).

In this app, pattern results are **entered by the user** during the AUTO→TELEOP break and at
match end (the app cannot reliably read settled RAMP arrangement from arbitrary video).

## What this feature detects vs. what is manual

| Item | How it's captured |
|---|---|
| Classified / overflow artifact scoring | **Experimental browser computer vision**: canvas colour-blob detection in two user-placed goal zones, fed to a direction-agnostic **presence-pulse tripwire** (each artifact passing through the gate = one counted pulse). Artifact colours are **user-calibrated by clicking an artifact** in a frame (the biggest accuracy lever). **Full manual review/correction** on every event. Not a replacement for a referee. |
| Match phase (auto/teleop/endgame) | Derived from the user-calibrated match-start time + official timing above. |
| Auto & teleop PATTERN | **Manually entered** (count of RAMP artifacts matching the MOTIF). |
| LEAVE | **Manually entered** (per-robot). |
| Endgame / BASE | **Manually entered** (per-robot partial/full + both-full bonus). |
| DEPOT | Not captured in this version. |

## Not yet detectable from video (documented limitations)

- Settled RAMP pattern arrangement (needs a clear top-down goal view) → manual entry.
- LEAVE / BASE robot positions → manual entry.
- DEPOT artifacts → not implemented.
- The color-detection CV is **experimental**: accuracy depends on video resolution, camera
  stability, lighting, and goal visibility. Every detected event is reviewable and
  correctable, and low-confidence events are flagged for review.
