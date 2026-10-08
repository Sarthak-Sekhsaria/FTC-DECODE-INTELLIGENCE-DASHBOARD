#!/usr/bin/env node
// Fetch FTC match videos from YouTube for testing Auto Scouting (ROI placement + counting).
//
// Uses yt-dlp (https://github.com/yt-dlp/yt-dlp) and, for cutting a match out of a long
// event livestream, ffmpeg. Both are looked for in the tools folder (default
// %LOCALAPPDATA%\ArtifactIQ\tools, override with ARTIFACTIQ_TOOLS); yt-dlp is fetched from
// its official GitHub release and checksum-verified if it is missing.
//
// Videos are saved at one of the heights Auto Scouting is tested at — 240p / 360p (low-quality
// stream copies) and 480p / 720p / 1080p (typical phone recordings and event streams) — as
// H.264 MP4 without audio, which plays in the browser and decodes everywhere.
//
//   node scripts/fetch-training-videos.mjs search "FTC DECODE match" [--n 25] [--max-min 15]
//   node scripts/fetch-training-videos.mjs download <url|id> [--height 240|360|480|720|1080] [--name file-name]
//        [--section 1:23-4:10] [--angle "text"] [--notes "text"]
//   node scripts/fetch-training-videos.mjs batch <list.json>
//
// Common options: --out <dir> (default: %USERPROFILE%\Downloads\ArtifactIQ training videos)
// Every download is recorded in <out>/videos.json (source URL, title, channel, height, window).
//
// For personal testing only: respect the uploaders' rights and YouTube's terms.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");
const TOOLS = process.env.ARTIFACTIQ_TOOLS ?? path.join(LOCAL, "ArtifactIQ", "tools");
const EXE = process.platform === "win32" ? ".exe" : "";
const YTDLP = path.join(TOOLS, `yt-dlp${EXE}`);
const FFMPEG = path.join(TOOLS, `ffmpeg${EXE}`);
const ALLOWED_HEIGHTS = [240, 360, 480, 720, 1080];

// ---- args -------------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = [];
const opts = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  else positional.push(argv[i]);
}
const OUT = path.resolve(opts.out ?? path.join(HOME, "Downloads", "ArtifactIQ training videos"));

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---- tools ------------------------------------------------------------------------
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  const asset = process.platform === "win32" ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp";
  const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
  console.log(`yt-dlp not found — downloading ${asset} from ${base} ...`);
  fs.mkdirSync(TOOLS, { recursive: true });
  const bin = Buffer.from(await (await fetch(`${base}/${asset}`)).arrayBuffer());
  const sums = await (await fetch(`${base}/SHA2-256SUMS`)).text();
  const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
  const actual = createHash("sha256").update(bin).digest("hex");
  if (!expected || expected !== actual) die(`checksum mismatch for ${asset} (expected ${expected}, got ${actual}) — not installed`);
  fs.writeFileSync(YTDLP, bin, { mode: 0o755 });
  console.log(`installed ${YTDLP} (sha256 verified)`);
}

function ytdlp(args, { capture = false } = {}) {
  // Node is a supported JavaScript runtime for yt-dlp's YouTube extractor.
  const full = ["--js-runtimes", "node", "--no-warnings", ...args];
  if (fs.existsSync(FFMPEG)) full.unshift("--ffmpeg-location", TOOLS);
  const r = spawnSync(YTDLP, full, { encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(`yt-dlp failed (${r.status}): ${(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout ?? "";
}

// Scale a video down to `height` (H.264, no audio) — for sources without a native stream at
// that height (e.g. 360p but no 240p).
function transcode(src, dst, height) {
  if (!fs.existsSync(FFMPEG)) die(`ffmpeg is needed to make a ${height}p copy (put it in ${TOOLS})`);
  const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-an", "-vf", `scale=-2:${height}`, "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst], { encoding: "utf8" });
  if (r.status !== 0) die(`ffmpeg failed: ${r.stderr}`);
}

// ---- helpers ----------------------------------------------------------------------
const toSec = (s) => s.split(":").reduce((a, v) => a * 60 + Number(v), 0);
const slug = (s) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);

function videoUrl(v) {
  return /^https?:/.test(v) ? v : `https://www.youtube.com/watch?v=${v}`;
}

// Exactly the requested height, H.264 MP4 first.
function formatFor(h) {
  return [`bv*[height=${h}][vcodec^=avc1][ext=mp4]`, `bv*[height=${h}][ext=mp4]`, `bv*[height=${h}]`].join("/");
}

function readManifest() {
  const f = path.join(OUT, "videos.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}

function writeManifest(list) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "videos.json"), JSON.stringify(list, null, 2) + "\n");
}

// ---- commands ---------------------------------------------------------------------
async function search(query, n, maxMin) {
  const out = ytdlp(["--flat-playlist", "--dump-json", `ytsearch${n}:${query}`], { capture: true });
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((v) => ({ id: v.id, minutes: v.duration ? +(v.duration / 60).toFixed(1) : null, channel: v.channel ?? v.uploader, title: v.title, url: videoUrl(v.id) }))
    .filter((v) => maxMin == null || (v.minutes != null && v.minutes <= maxMin));
  for (const r of rows) console.log(`${r.id}  ${String(r.minutes ?? "?").padStart(6)} min  ${(r.channel ?? "").slice(0, 28).padEnd(28)}  ${r.title}`);
  return rows;
}

async function download(src, o) {
  const height = Number(o.height ?? 360);
  if (!ALLOWED_HEIGHTS.includes(height)) die(`--height must be one of ${ALLOWED_HEIGHTS.join(", ")} (got ${o.height})`);
  const info = JSON.parse(ytdlp(["--dump-json", "--no-playlist", videoUrl(src)], { capture: true }));
  const name = o.name ? slug(o.name) : `${slug(info.title)}-${info.id}`;
  const file = path.join(OUT, `${name}-${height}p.mp4`);
  fs.mkdirSync(OUT, { recursive: true });
  let section = null;
  const sectionArgs = [];
  if (o.section) {
    if (!fs.existsSync(FFMPEG)) die(`--section needs ffmpeg in ${TOOLS}`);
    const [a, b] = String(o.section).split("-");
    section = { start: toSec(a), end: toSec(b) };
    sectionArgs.push("--download-sections", `*${section.start}-${section.end}`, "--force-keyframes-at-cuts");
  }
  const heights = new Set((info.formats ?? []).filter((f) => f.vcodec && f.vcodec !== "none").map((f) => f.height));
  // The native stream at the requested height; otherwise the nearest allowed one scaled to it.
  const source = heights.has(height) ? height : ALLOWED_HEIGHTS.filter((h) => h >= height && heights.has(h))[0];
  if (!source) die(`no ${ALLOWED_HEIGHTS.join("p/")}p stream for ${info.id} (has: ${[...heights].sort((a, b) => a - b).join(", ")})`);
  const dl = source === height ? file : path.join(OUT, `${name}-${source}p.src.mp4`);
  console.log(`downloading ${info.id} "${info.title}" at ${source}p${source !== height ? ` (no ${height}p stream: will scale to ${height}p)` : ""}${section ? ` (${o.section})` : ""} -> ${file}`);
  ytdlp(["-f", formatFor(source), "--no-playlist", "--no-part", "--force-overwrites", ...sectionArgs, "-o", dl, videoUrl(src)]);
  if (!fs.existsSync(dl)) die(`expected output ${dl} is missing`);
  if (dl !== file) {
    transcode(dl, file, height);
    fs.rmSync(dl);
  }
  const entry = {
    file: path.basename(file),
    id: info.id,
    url: videoUrl(info.id),
    title: info.title,
    channel: info.channel ?? info.uploader,
    uploadDate: info.upload_date,
    height,
    scaledFrom: source !== height ? source : null,
    section,
    angle: o.angle ?? null,
    notes: o.notes ?? null,
    bytes: fs.statSync(file).size,
    downloadedAt: new Date().toISOString(),
  };
  const list = readManifest().filter((e) => e.file !== entry.file);
  list.push(entry);
  writeManifest(list);
  console.log(`saved ${entry.file} (${(entry.bytes / 1e6).toFixed(1)} MB)`);
  return entry;
}

// ---- main -------------------------------------------------------------------------
await ensureYtDlp();
if (cmd === "search") {
  if (!positional[0]) die('usage: search "<query>" [--n 25] [--max-min 15]');
  await search(positional[0], Number(opts.n ?? 25), opts["max-min"] != null ? Number(opts["max-min"]) : null);
} else if (cmd === "download") {
  if (!positional[0]) die("usage: download <url|id> [--height 240|360|480|720|1080] [--section m:ss-m:ss] [--name ...]");
  await download(positional[0], opts);
} else if (cmd === "batch") {
  if (!positional[0]) die("usage: batch <list.json>  (array of {url, height, section?, name?, angle?, notes?})");
  const list = JSON.parse(fs.readFileSync(positional[0], "utf8"));
  for (const v of list) await download(v.url ?? v.id, v);
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
}
