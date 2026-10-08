import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

// Serves the OpenCV.js build (from the @techstark/opencv-js dependency) so Auto
// Scouting's ROI placement can load it on demand without bundling ~10 MB into the
// page. The file never changes for a given install, so it is cached hard.
let cached: Buffer | null = null;

export async function GET() {
  try {
    if (!cached) cached = await fs.readFile(path.join(process.cwd(), "node_modules", "@techstark", "opencv-js", "dist", "opencv.js"));
    return new Response(new Uint8Array(cached), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("// OpenCV.js not installed — run npm install", { status: 500, headers: { "Content-Type": "text/javascript" } });
  }
}
