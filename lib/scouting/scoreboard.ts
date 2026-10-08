// Reads the FTC Live score bar that event broadcasts put on the video (DOM-free, unit-tested).
//
// Every DECODE broadcast in the benchmark — qualifiers, state championships, the World
// Championship — shows the same bar: a red and a blue alliance panel either side of a white
// timer box. Each panel has small white value boxes beside icons: the CLASSIFIED ARTIFACTS
// (ball icon), the OVERFLOW ARTIFACTS (arrow), the PATTERN matches and the robots' BASE state,
// then the team numbers and the alliance score. The numbers are the scorekeepers' live,
// official counts, so when the bar is in the video they are the ARTIFACT counts.
//
// Nothing is assumed about where the bar is or how big: it is found from its colours (rows
// that are red on one side and blue on the other around a white box), at the top or the bottom
// of the picture, at any scale, either alliance on the left. The value boxes are then found as
// white rectangles inside each panel and told apart by their shape and position.

import type { Frame } from "./calibration.ts";

export type Side = "left" | "right";
export type Alliance = "red" | "blue";

export interface Box {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number;
}

export interface ScoreBarLayout {
  row: { y0: number; y1: number }; // the score row (panels + timer), native px
  unit: number; // the layout unit: the score row's designed height (180 px at 1080p)
  timer: Box;
  left: Alliance; // the alliance whose panel is on the left
  panels: Record<Side, PanelBoxes>;
}

export interface PanelBoxes {
  alliance: Alliance;
  panel: Box;
  classified: Box | null; // value box beside the ball icon
  overflow: Box | null; // value box beside the arrow
  teams: Box[]; // team number boxes, top to bottom
}

const isRed = (r: number, g: number, b: number) => r > 90 && r > 1.7 * g && r > 1.5 * b;
// (purple, as in the motif balls on the timer, has more red than green: not panel blue)
const isBlue = (r: number, g: number, b: number) => b > 90 && r < 0.45 * b && g > r && b > 1.05 * g && b - r > 40;
const isWhite = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40;

function px(f: Frame, x: number, y: number): [number, number, number] {
  const i = (y * f.width + x) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
}

// Fraction of red / blue / white pixels in a row segment, sampled every `step` px.
function rowStats(f: Frame, y: number, x0: number, x1: number, step: number) {
  let red = 0, blue = 0, white = 0, n = 0;
  for (let x = Math.max(0, x0); x < Math.min(f.width, x1); x += step) {
    const [r, g, b] = px(f, x, y);
    if (isRed(r, g, b)) red++;
    else if (isBlue(r, g, b)) blue++;
    else if (isWhite(r, g, b)) white++;
    n++;
  }
  return { red: red / Math.max(1, n), blue: blue / Math.max(1, n), white: white / Math.max(1, n) };
}

// Candidate score rows: runs of rows whose outer thirds are one alliance colour each, longest
// first. The panels carry white boxes, icons, digits and grey box edges: in TELEOP, with the
// robots' BASE boxes and three team numbers shown, some rows are only ~25% panel colour (FIRST
// Championship layout at 720p). So a row qualifies when its third is at least 15% one alliance
// colour and holds almost none of the other's, and the run as a whole must average at least 30%
// on both sides. A run must be 7-25% of the picture high and touch the top or bottom fifth of
// it. The red and the blue GOAL on either side of an overhead view can make such a run too, so
// findScoreBar takes the first candidate with the bar's structure (the white timer box between
// the panels and the value boxes in them).
export function findScoreRows(f: Frame): { y0: number; y1: number; left: Alliance }[] {
  const step = Math.max(1, Math.round(f.width / 320));
  const third = Math.round(f.width / 3);
  const panelOf = (s: { red: number; blue: number; white: number }): Alliance | null =>
    s.red >= 0.15 && s.blue < 0.03 ? "red" : s.blue >= 0.15 && s.red < 0.03 ? "blue" : null;
  const kind: (Alliance | null)[] = [];
  const cover: number[] = []; // the smaller of the two sides' panel colour fractions
  for (let y = 0; y < f.height; y++) {
    const ls = rowStats(f, y, 0, third, step), rs = rowStats(f, y, f.width - third, f.width, step);
    const L = panelOf(ls), R = panelOf(rs);
    kind.push(L && R && L !== R ? L : null);
    cover.push(L && R && L !== R ? Math.min(ls[L], rs[R]) : 0);
  }
  const runs: { y0: number; y1: number; left: Alliance }[] = [];
  for (let y = 0; y < f.height; ) {
    const k = kind[y];
    if (!k) {
      y++;
      continue;
    }
    // allow 1-2 row gaps (icons, anti-aliasing) inside the run
    let e = y;
    while (e + 1 < f.height && (kind[e + 1] === k || (kind[e + 2] === k && kind[e + 1] == null) || (kind[e + 3] === k && kind[e + 1] == null && kind[e + 2] == null))) e++;
    const h = e - y + 1;
    let mean = 0;
    for (let i = y; i <= e; i++) mean += cover[i] / h;
    const fits = mean >= 0.3 && h >= 0.07 * f.height && h <= 0.25 * f.height && (y <= 0.2 * f.height || e + 1 >= 0.8 * f.height);
    if (fits) runs.push({ y0: y, y1: e + 1, left: k });
    y = e + 1;
  }
  return runs.sort((a, b) => b.y1 - b.y0 - (a.y1 - a.y0));
}

// The longest candidate score row (see findScoreRows).
export function findScoreRow(f: Frame): { y0: number; y1: number; left: Alliance } | null {
  return findScoreRows(f)[0] ?? null;
}

// Connected white rectangles inside `area` (4-connected flood fill on a white mask).
function whiteBoxes(f: Frame, area: Box): Box[] {
  const W = area.x1 - area.x0, H = area.y1 - area.y0;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(f, area.x0 + x, area.y0 + y);
      mask[y * W + x] = isWhite(r, g, b) ? 1 : 0;
    }
  const seen = new Uint8Array(W * H);
  const out: Box[] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % W, y = (j / W) | 0;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= W * H || seen[k] || !mask[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === W - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // a value box is a filled rectangle: most of its bounding box is white
    if (n >= 0.6 * bw * bh) out.push({ x0: area.x0 + x0, y0: area.y0 + y0, x1: area.x0 + x1 + 1, y1: area.y0 + y1 + 1 });
  }
  return out;
}

// ---- digits ------------------------------------------------------------------------

// A digit glyph normalised for matching: grey levels of its bounding box (dark = 1, background
// = 0) scaled to GLYPH_H rows, kept at its own aspect ratio and centred in GLYPH_W columns (so a
// "1" stays narrow), then made zero-mean and unit-norm.
export const GLYPH_W = 14;
export const GLYPH_H = 20;

export interface DigitTemplate {
  digit: number;
  v: number[]; // GLYPH_W * GLYPH_H normalised values
}

// Dark glyphs inside a white value box, left to right: each is a group of dark pixels at least
// half the box's text height, with nearby fragments (a "4" can break up at 240p) merged in.
export function glyphs(f: Frame, box: Box): Float32Array[] {
  const pad = Math.max(1, Math.round(0.06 * (box.y1 - box.y0)));
  const x0 = box.x0 + pad, y0 = box.y0 + pad, x1 = box.x1 - pad, y1 = box.y1 - pad;
  const W = x1 - x0, H = y1 - y0;
  if (W < 3 || H < 4) return [];
  const g = new Float32Array(W * H);
  let lo = 255, hi = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, gg, b] = px(f, x0 + x, y0 + y);
      const v = 0.299 * r + 0.587 * gg + 0.114 * b;
      g[y * W + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (hi - lo < 60) return []; // no text: a plain box
  const thr = (lo + hi) / 2;
  // columns holding dark pixels, grouped into runs (digits are separated by light columns)
  const colDark = new Array(W).fill(0);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (g[y * W + x] < thr) colDark[x]++;
  const runs: [number, number][] = [];
  for (let x = 0; x < W; ) {
    if (!colDark[x]) {
      x++;
      continue;
    }
    let e = x;
    while (e + 1 < W && colDark[e + 1]) e++;
    runs.push([x, e + 1]);
    x = e + 1;
  }
  // each run's vertical extent; digits are as tall as the tallest glyph in the box (text fills
  // ~60% of a value box but only ~37% of a team box), specks are not
  const ext = runs.map(([a, b]) => {
    let top = H, bot = -1;
    for (let y = 0; y < H; y++) for (let x = a; x < b; x++) if (g[y * W + x] < thr) { if (y < top) top = y; if (y > bot) bot = y; }
    return { top, bot };
  });
  const tallest = Math.max(0, ...ext.map((e) => e.bot - e.top + 1));
  if (tallest < 4) return [];
  const out: Float32Array[] = [];
  for (let r = 0; r < runs.length; r++) {
    const [a, b] = runs[r];
    const { top, bot } = ext[r];
    const gh = bot - top + 1;
    if (gh < 0.6 * tallest) continue; // a speck, not a digit
    // digits that touch (small text, compression) come as one wide run: a bold digit is about
    // 0.6x as wide as high, so a run wider than ~0.95x is split into equal parts
    const k = (b - a) / gh > 0.95 ? Math.max(2, Math.round((b - a) / (0.62 * gh))) : 1;
    for (let i = 0; i < k; i++) {
      const sa = Math.round(a + ((b - a) * i) / k), sb = Math.round(a + ((b - a) * (i + 1)) / k);
      let st = H, sbot = -1;
      for (let y = 0; y < H; y++) for (let x = sa; x < sb; x++) if (g[y * W + x] < thr) { if (y < st) st = y; if (y > sbot) sbot = y; }
      if (sbot >= st) out.push(normaliseGlyph(g, W, sa, st, sb, sbot + 1, lo, hi));
    }
  }
  return out;
}

function normaliseGlyph(g: Float32Array, W: number, x0: number, y0: number, x1: number, y1: number, lo: number, hi: number): Float32Array {
  const gw = x1 - x0, gh = y1 - y0;
  const s = GLYPH_H / gh; // scale by height, keep aspect
  const ow = Math.min(GLYPH_W, Math.max(1, Math.round(gw * s)));
  const off = Math.floor((GLYPH_W - ow) / 2);
  const v = new Float32Array(GLYPH_W * GLYPH_H);
  for (let y = 0; y < GLYPH_H; y++)
    for (let x = 0; x < ow; x++) {
      // bilinear sample of the glyph's box
      const sx = x0 + ((x + 0.5) / ow) * gw - 0.5, sy = y0 + ((y + 0.5) / GLYPH_H) * gh - 0.5;
      const ix = Math.max(x0, Math.min(x1 - 1, Math.floor(sx))), iy = Math.max(y0, Math.min(y1 - 1, Math.floor(sy)));
      const jx = Math.min(x1 - 1, ix + 1), jy = Math.min(y1 - 1, iy + 1);
      const fx = Math.max(0, Math.min(1, sx - ix)), fy = Math.max(0, Math.min(1, sy - iy));
      const val = (1 - fx) * (1 - fy) * g[iy * W + ix] + fx * (1 - fy) * g[iy * W + jx] + (1 - fx) * fy * g[jy * W + ix] + fx * fy * g[jy * W + jx];
      v[y * GLYPH_W + off + x] = (hi - val) / (hi - lo); // dark = 1
    }
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length;
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] -= m;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Best matching digit for a glyph (normalised cross-correlation with every template) and the
// margin to the best other digit.
export function classifyGlyph(v: Float32Array, bank: DigitTemplate[]): { digit: number; score: number; margin: number } {
  const best = new Array(10).fill(-Infinity);
  for (const t of bank) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * t.v[i];
    if (s > best[t.digit]) best[t.digit] = s;
  }
  let d = 0;
  for (let k = 1; k < 10; k++) if (best[k] > best[d]) d = k;
  const other = Math.max(...best.filter((_, k) => k !== d));
  return { digit: d, score: best[d], margin: best[d] - other };
}

// The number in a value box, or null when it cannot be read with confidence.
export function readNumber(f: Frame, box: Box | null, bank: DigitTemplate[], minScore = 0.75, minMargin = 0.05): { value: number; digits: number } | null {
  if (!box) return null;
  const gs = glyphs(f, box);
  if (!gs.length || gs.length > 4) return null;
  let value = 0;
  for (const v of gs) {
    const c = classifyGlyph(v, bank);
    if (c.score < minScore || c.margin < minMargin) return null;
    value = value * 10 + c.digit;
  }
  return { value, digits: gs.length };
}

// Find the bar and its value boxes. Box sizes are relative to the score row's height h (at
// 1080p the row is 180 px): the CLASSIFIED and OVERFLOW value boxes are ~0.45h wide and ~0.28h
// high, stacked (OVERFLOW above); the PATTERN and BASE boxes are wider (~0.7h); the team boxes
// are ~0.83h wide and sit next to the alliance score.
export function findScoreBar(f: Frame): ScoreBarLayout | null {
  for (const row of findScoreRows(f)) {
    const L = scoreBarAt(f, row);
    // the bar's structure: a value box pair in at least one panel
    if (L && (L.panels.left.classified || L.panels.right.classified)) return L;
  }
  return null;
}

function scoreBarAt(f: Frame, row: { y0: number; y1: number; left: Alliance }): ScoreBarLayout | null {
  const h = row.y1 - row.y0;
  // the timer: the widest run of columns in the middle half of the row with (almost) no panel
  // colour from top to bottom — a white box holding the black clock and the motif's coloured
  // balls, between the two panels
  const ystep = Math.max(1, Math.round(h / 40));
  let tx0 = -1, tx1 = -1, run0 = -1;
  for (let x = Math.round(0.25 * f.width); x <= Math.round(0.75 * f.width); x++) {
    let panelColour = 0, n = 0;
    for (let y = row.y0 + 1; y < row.y1 - 1; y += ystep) {
      const [r, g, b] = px(f, x, y);
      if (isRed(r, g, b) || isBlue(r, g, b)) panelColour++;
      n++;
    }
    const on = panelColour <= 0.08 * n;
    if (on && run0 < 0) run0 = x;
    if ((!on || x === Math.round(0.75 * f.width)) && run0 >= 0) {
      if (x - run0 > tx1 - tx0) [tx0, tx1] = [run0, x];
      run0 = -1;
    }
  }
  if (tx1 - tx0 < 0.6 * h || tx1 - tx0 > 3 * h) return null;
  // The layout unit u: the score row's height as designed (180 px at 1080p), from the timer box,
  // which is 1.144 u wide. (The run of panel-coloured rows can come out short: at 360p the top
  // and bottom rows of the panels blend into the picture.) Boxes are searched within 0.75 u of
  // the row's middle.
  const u = (tx1 - tx0) / 1.144;
  const yc = (row.y0 + row.y1) / 2;
  const y0 = Math.max(0, Math.round(yc - 0.75 * u)), y1 = Math.min(f.height, Math.round(yc + 0.75 * u));
  // the timer box itself: the rows of the timer columns that are partly white (the title row
  // above it is black across, the picture beyond it is not white)
  let ty0 = -1, ty1 = -1;
  for (let y = y0; y < y1; y++) {
    let white = 0, n = 0;
    for (let x = tx0 + 1; x < tx1 - 1; x += Math.max(1, Math.round(u / 60))) {
      const [r, g, b] = px(f, x, y);
      if (isWhite(r, g, b)) white++;
      n++;
    }
    if (white >= 0.3 * n) {
      if (ty0 < 0) ty0 = y;
      ty1 = y + 1;
    }
  }
  if (ty0 < 0) return null;
  const timer: Box = { x0: tx0, y0: ty0, x1: tx1, y1: ty1 };
  const right: Alliance = row.left === "red" ? "blue" : "red";
  const panel = (side: Side): PanelBoxes => {
    const p: Box = side === "left" ? { x0: 0, y0, x1: tx0, y1 } : { x0: tx1, y0, x1: f.width, y1 };
    const boxes = whiteBoxes(f, p).filter((q) => (q.y1 - q.y0) / u >= 0.15 && (q.y1 - q.y0) / u <= 0.6 && (q.x1 - q.x0) / u >= 0.25);
    // CLASSIFIED / OVERFLOW value boxes: ~0.43 u wide, ~0.26 u high, stacked (OVERFLOW above)
    const narrow = boxes.filter((q) => (q.x1 - q.x0) / u >= 0.3 && (q.x1 - q.x0) / u <= 0.6 && (q.y1 - q.y0) / u <= 0.4);
    let pair: [Box, Box] | null = null;
    for (const a of narrow)
      for (const b of narrow) {
        if (a === b || b.y0 <= a.y0) continue;
        const sameColumn = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < 0.15 * u;
        if (sameColumn && b.y0 - a.y1 < 0.15 * u && (!pair || a.y0 < pair[0].y0)) pair = [a, b];
      }
    // team boxes: ~0.83 u wide, beside the alliance score (the inner half of the panel)
    const teams = boxes
      .filter((q) => (q.x1 - q.x0) / u > 0.6 && (q.x1 - q.x0) / u < 1.1 && (q.y1 - q.y0) / u < 0.5)
      .filter((q) => (side === "left" ? q.x0 > 0.45 * tx0 : q.x1 < tx1 + 0.55 * (f.width - tx1)))
      .sort((a, b) => a.y0 - b.y0);
    return { alliance: side === "left" ? row.left : right, panel: p, overflow: pair ? pair[0] : null, classified: pair ? pair[1] : null, teams };
  };
  return { row: { y0, y1 }, unit: u, timer, left: row.left, panels: { left: panel("left"), right: panel("right") } };
}

// The clock (m:ss) in the timer box: the tallest band of rows holding dark pixels (the gamepad
// icon above it is a shorter band; the motif's balls below are coloured, not dark). Found from
// the pixels rather than as a fixed share of the box, because a broadcast can crop the bottom
// of the bar off (DC1). The colon's two dots span most of a digit's height, so they come out as
// the second of four glyphs and are dropped.
export function readClock(f: Frame, L: ScoreBarLayout, bank: DigitTemplate[], minScore = 0.7): number | null {
  const { x0, x1, y0, y1 } = L.timer;
  const m = Math.round(0.08 * (x1 - x0));
  const dark: number[] = [];
  for (let y = y0; y < y1; y++) {
    let d = 0;
    for (let x = x0 + m; x < x1 - m; x++) {
      const [r, g, b] = px(f, x, y);
      if (Math.max(r, g, b) < 90) d++;
    }
    dark.push(d);
  }
  let best: [number, number] | null = null;
  for (let i = 0; i < dark.length; ) {
    if (!dark[i]) {
      i++;
      continue;
    }
    let e = i;
    while (e + 1 < dark.length && dark[e + 1]) e++;
    if (!best || e - i > best[1] - best[0]) best = [i, e + 1];
    i = e + 1;
  }
  if (!best || best[1] - best[0] < 4) return null;
  const band: Box = { x0, y0: Math.max(y0, y0 + best[0] - 1), x1, y1: Math.min(y1, y0 + best[1] + 1) };
  let gs = glyphs(f, band);
  if (gs.length === 4) gs = [gs[0], gs[2], gs[3]];
  if (gs.length !== 3) return null;
  const ds = gs.map((v) => classifyGlyph(v, bank));
  if (ds.some((d) => d.score < minScore || d.margin < 0.03) || ds[1].digit > 5) return null;
  return ds[0].digit * 60 + ds[1].digit * 10 + ds[2].digit;
}

export interface AllianceScore {
  classified: number | null;
  overflow: number | null;
}

export interface ScoreBarReading {
  clock: number | null; // seconds shown on the match clock
  red: AllianceScore;
  blue: AllianceScore;
  layout: ScoreBarLayout;
}

// The smallest value box whose digits are read (px high). At 360p the boxes are 16 px and every
// count was read right; at 240p they are 10 px, the digits ~7 px, and readings come out wrong
// (Hawaii red 76 against 85). The clock's digits are bigger and still read there.
export const MIN_VALUE_BOX_PX = 13;

// Everything the bar says in this frame, or null when there is no bar.
export function readScoreBar(f: Frame, bank: DigitTemplate[]): ScoreBarReading | null {
  const L = findScoreBar(f);
  if (!L) return null;
  const out: ScoreBarReading = { clock: readClock(f, L, bank), red: { classified: null, overflow: null }, blue: { classified: null, overflow: null }, layout: L };
  const legible = (b: Box | null) => (b && b.y1 - b.y0 >= MIN_VALUE_BOX_PX ? b : null);
  for (const side of ["left", "right"] as const) {
    const P = L.panels[side];
    out[P.alliance] = { classified: readNumber(f, legible(P.classified), bank)?.value ?? null, overflow: readNumber(f, legible(P.overflow), bank)?.value ?? null };
  }
  return out;
}

// The digit templates shipped with the app (scoreboardDigits.json): glyphs of the team numbers
// on seven broadcasts from 240p to 1080p, stored as int8. Every team number on each of those
// broadcasts was read right with templates from the other broadcasts only (766 of 766).
export interface PackedDigits {
  w: number;
  h: number;
  templates: { d: number; s: number; q: string }[];
}

export function unpackDigits(p: PackedDigits): DigitTemplate[] {
  if (p.w !== GLYPH_W || p.h !== GLYPH_H) throw new Error(`digit templates are ${p.w}x${p.h}, expected ${GLYPH_W}x${GLYPH_H}`);
  const decode = (b64: string): Int8Array => {
    const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
  };
  return p.templates.map((t) => {
    const q = decode(t.q);
    const v = Array.from(q, (x) => (x / 127) * t.s);
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return { digit: t.d, v: v.map((x) => x / n) };
  });
}

// ---- over time ---------------------------------------------------------------------

export interface ScoreBarSample {
  t: number; // video seconds
  clock: number | null;
  red: AllianceScore;
  blue: AllianceScore;
}

export interface ScoreBarWindow {
  start: number; // video seconds: the start of AUTO
  teleopStart: number;
  buzzer: number; // the end of TELEOP (the clock reaching 0:00)
  transitionSec: number;
  final: boolean; // TELEOP has been seen to end
}

export interface ScoreBarCounts {
  red: { classified: number; overflow: number };
  blue: { classified: number; overflow: number };
}

const AUTO_SEC = 30, TELEOP_SEC = 120, PRE_MATCH_CLOCK = 150;
// After the buzzer the scorekeepers still enter the last ARTIFACTS and corrections while the bar
// shows 0:00 (up to ~3 s later in the benchmark broadcasts, some changes downwards). The counts
// are final once the bar is gone, the clock runs again (the next match), nothing has changed for
// POST_QUIET_SEC, or POST_MAX_SEC have passed.
export const POST_QUIET_SEC = 5;
export const POST_MAX_SEC = 30;
const BAR_GONE_SEC = 2;

// The score bar read over a video. A count only changes when the new value has been read in two
// readings in a row (one misread frame cannot change the score; a scorekeeper's correction —
// a value going down — is accepted the same way). The match window comes from the clock:
// FTC Live shows 2:30 before the match, counts 2:29..2:01 through AUTO, counts the transition
// down (0:08..0:01; 0:15 at the FIRST Championship), then 2:00..0:00 through TELEOP.
export class ScoreBarTracker {
  private samples: ScoreBarSample[] = [];
  private tries: { t: number; bar: boolean }[] = []; // every reading attempted

  reset() {
    this.samples = [];
    this.tries = [];
  }

  push(t: number, r: ScoreBarReading | null) {
    // a seek backwards (live replay): forget what comes after, it will be read again
    if (this.tries.length && t < this.tries[this.tries.length - 1].t - 1e-3) {
      this.samples = this.samples.filter((s) => s.t < t);
      this.tries = this.tries.filter((s) => s.t < t);
    }
    this.tries.push({ t, bar: !!r });
    if (r) this.samples.push({ t, clock: r.clock, red: { ...r.red }, blue: { ...r.blue } });
  }

  // The bar is in this video: seen in at least 6 readings, and in most of those attempted during
  // the match (a video can have an intro, replays or interviews without it).
  get present(): boolean {
    if (this.samples.length < 6) return false;
    const w = this.window();
    const tries = w ? this.tries.filter((x) => x.t >= w.start && x.t <= w.buzzer) : this.tries;
    return tries.filter((x) => x.bar).length >= 0.5 * tries.length;
  }

  // The bar's ARTIFACT counts can be used: both alliances' CLASSIFIED counts were read in most
  // readings of the bar (in a small or blurred bar the clock may be legible and the counts not).
  get countsReadable(): boolean {
    if (!this.present) return false;
    const w = this.window();
    const s = w ? this.samples.filter((x) => x.t >= w.start && x.t <= w.buzzer) : this.samples;
    if (!s.length) return false;
    return (["red", "blue"] as const).every((a) => s.filter((x) => x[a].classified != null).length >= 0.5 * s.length);
  }

  get lastT(): number {
    return this.samples.length ? this.samples[this.samples.length - 1].t : -Infinity;
  }

  // The last video time a reading was attempted (with or without the bar).
  get lastTried(): number {
    return this.tries.length ? this.tries[this.tries.length - 1].t : -Infinity;
  }

  // Accepted values of one count over time: [time it was accepted, value].
  private accepted(alliance: Alliance, kind: "classified" | "overflow"): [number, number][] {
    const out: [number, number][] = [];
    let cur: number | null = null, cand: number | null = null, streak = 0;
    for (const s of this.samples) {
      const v = s[alliance][kind];
      if (v == null) continue;
      if (v === cand) streak++;
      else {
        cand = v;
        streak = 1;
      }
      if (streak >= 2 && cand !== cur) {
        cur = cand;
        out.push([s.t, cur]);
      }
    }
    return out;
  }

  window(): ScoreBarWindow | null {
    const s = this.samples.filter((x) => x.clock != null) as (ScoreBarSample & { clock: number })[];
    if (s.length < 4) return null;
    // the jump to TELEOP: a transition countdown value (<= 15) followed within 3 s by >= 110
    let jump = -1;
    for (let i = 1; i < s.length; i++) if (s[i - 1].clock <= 15 && s[i].clock >= 110 && s[i].clock <= TELEOP_SEC && s[i].t - s[i - 1].t <= 3) jump = i;
    const median = (xs: number[]) => {
      const q = [...xs].sort((a, b) => a - b);
      return q.length ? q[q.length >> 1] : NaN;
    };
    // TELEOP readings: after the jump (or, with no jump seen, clocks 16..120 — a transition
    // countdown never shows more than 0:15)
    const tele = jump >= 0 ? s.slice(jump).filter((x) => x.clock <= TELEOP_SEC) : s.filter((x) => x.clock > 15 && x.clock <= TELEOP_SEC);
    if (tele.length < 3) return null;
    const teleopStart = median(tele.map((x) => x.t - (TELEOP_SEC - x.clock) - 0.5));
    // keep only readings consistent with it (the end-of-TELEOP countdown is, an early transition is not)
    const auto = s.filter((x) => x.t < teleopStart && x.clock > TELEOP_SEC && x.clock < PRE_MATCH_CLOCK);
    const trans = s.filter((x) => x.t < teleopStart && x.t > teleopStart - 20 && x.clock <= 15);
    const transitionSec = trans.length ? Math.max(...trans.map((x) => x.clock)) : 8;
    const start = auto.length >= 3 ? median(auto.map((x) => x.t - (PRE_MATCH_CLOCK - x.clock) - 0.5)) : teleopStart - AUTO_SEC - transitionSec;
    const buzzer = teleopStart + TELEOP_SEC;
    const final = s.some((x) => x.t >= buzzer - 0.5 && x.clock === 0);
    return { start, teleopStart, buzzer, transitionSec, final };
  }

  // When this match's counts became final on the bar (see POST_QUIET_SEC), or null while they
  // can still change. Needs the buzzer seen on the clock.
  settledAt(): number | null {
    const w = this.window();
    if (!w || !w.final) return null;
    const B = w.buzzer;
    // the 0:00 hold: from the first 0:00 reading until the clock runs again (the next match) or
    // the bar is gone
    let holdEnd = Infinity, prev = B - 0.5, held = false;
    for (const s of this.samples) {
      if (s.t < B - 0.5) continue;
      if (!held) {
        if (s.clock !== 0) continue; // the last seconds of TELEOP
        held = true;
      } else if (s.t - prev > BAR_GONE_SEC || (s.clock != null && s.clock > 0)) {
        holdEnd = prev;
        break;
      }
      prev = s.t;
    }
    if (holdEnd === Infinity && this.lastTried - prev > BAR_GONE_SEC) holdEnd = prev;
    let lastChange = B;
    for (const a of ["red", "blue"] as const)
      for (const k of ["classified", "overflow"] as const)
        for (const [t] of this.accepted(a, k)) if (t >= B - 0.5 && t <= holdEnd && t > lastChange) lastChange = t;
    const quiet = lastChange + POST_QUIET_SEC;
    const settled = Math.min(holdEnd, quiet, B + POST_MAX_SEC);
    return this.lastTried >= settled ? Math.max(B, settled) : null;
  }

  // The accepted counts at time t (null before any were read).
  countsAt(t: number): ScoreBarCounts | null {
    const at = (a: Alliance, k: "classified" | "overflow") => {
      let v: number | null = null;
      for (const [tt, val] of this.accepted(a, k)) if (tt <= t + 1e-6) v = val;
      return v;
    };
    const rc = at("red", "classified"), bc = at("blue", "classified");
    if (rc == null || bc == null) return null;
    return { red: { classified: rc, overflow: at("red", "overflow") ?? 0 }, blue: { classified: bc, overflow: at("blue", "overflow") ?? 0 } };
  }

  // When each ARTIFACT was scored, as the scorekeepers entered it: one time per counted ARTIFACT
  // up to `until` (a correction downwards takes back the latest ones).
  scoringTimes(alliance: Alliance, kind: "classified" | "overflow", until = Infinity): number[] {
    const times: number[] = [];
    let prev = 0;
    for (const [t, v] of this.accepted(alliance, kind)) {
      if (t > until + 1e-6) break;
      if (v > prev) for (let i = prev; i < v; i++) times.push(t);
      else times.splice(Math.max(0, v), times.length - v);
      prev = v;
    }
    return times;
  }
}
