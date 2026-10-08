/* eslint-disable @typescript-eslint/no-explicit-any */
// OpenCV.js access for ROI placement. In the browser the ~10 MB OpenCV.js build is
// loaded lazily from /api/opencv (streamed from node_modules/@techstark/opencv-js)
// only when placement actually runs, so it never bloats the page bundle. Tests
// inject a Node instance with setOpenCV().

export type CV = any;

let instance: CV | null = null;
let loading: Promise<CV> | null = null;

export function setOpenCV(cv: CV) {
  instance = cv;
}

// Resolve whichever shape the emscripten build hands us (ready module, promise,
// or a module that fires onRuntimeInitialized later).
export function whenReady(mod: any): Promise<CV> {
  return new Promise((resolve, reject) => {
    if (!mod) return reject(new Error("OpenCV.js did not load"));
    if (typeof mod.then === "function") {
      // Some builds are thenables that resolve to themselves — strip `then` to avoid a loop.
      mod.then((m: any) => {
        if (m && typeof m.then === "function") delete m.then;
        resolve(m);
      }, reject);
      return;
    }
    if (mod.Mat) return resolve(mod);
    mod.onRuntimeInitialized = () => resolve(mod);
  });
}

export function loadOpenCV(src = "/api/opencv"): Promise<CV> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;
  if (typeof window === "undefined") return Promise.reject(new Error("loadOpenCV() is browser-only; tests must call setOpenCV()"));
  loading = new Promise<CV>((resolve, reject) => {
    const w = window as any;
    const done = (mod: any) =>
      whenReady(mod).then((cv) => {
        instance = cv;
        resolve(cv);
      }, reject);
    if (w.cv) return done(w.cv);
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => done(w.cv);
    s.onerror = () => {
      loading = null;
      reject(new Error("Could not load OpenCV.js"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

// Free every Mat/MatVector passed (ignores nulls). OpenCV.js memory is manual.
export function release(...objs: any[]) {
  for (const o of objs) {
    try {
      if (o && typeof o.delete === "function" && !(o.isDeleted?.() ?? false)) o.delete();
    } catch {
      /* already freed */
    }
  }
}
