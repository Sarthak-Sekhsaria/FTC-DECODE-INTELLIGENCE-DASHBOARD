import { promises as fs } from "fs";
import path from "path";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

// Serves the ONNX Runtime Web WebAssembly build (from the onnxruntime-web dependency) that runs
// the v2 RAMP counter's models in the browser, without copying ~14 MB into public/. Only the
// files the runtime asks for are served. They never change for a given install: cached hard.
const FILES: Record<string, string> = {
  "ort-wasm-simd-threaded.wasm": "application/wasm",
  "ort-wasm-simd-threaded.mjs": "text/javascript; charset=utf-8",
};
const cache = new Map<string, Buffer>();

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/ort/[file]">) {
  const { file } = await ctx.params;
  const type = FILES[file];
  if (!type) return new Response("not found", { status: 404 });
  try {
    let buf = cache.get(file);
    if (!buf) {
      buf = await fs.readFile(path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist", file));
      cache.set(file, buf);
    }
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    return new Response("onnxruntime-web not installed — run npm install", { status: 500 });
  }
}
