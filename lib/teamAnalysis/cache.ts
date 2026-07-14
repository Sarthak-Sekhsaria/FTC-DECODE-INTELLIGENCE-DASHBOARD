// Simple in-memory TTL + LRU cache for Single Team Analysis (Phase 4). Avoids
// re-hitting FTCScout and re-running the slow, paid Claude narrative on repeat
// views of the same team.
//
// In-process only: effective for a single long-lived server (how this app runs).
// A multi-instance serverless deployment would want an external store (Redis/DB),
// but this is dependency-free and correct within an instance's lifetime.

interface Entry<T> {
  value: T;
  at: number; // when it was stored (ms epoch)
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();

  constructor(
    private ttlMs: number,
    private max = 200,
  ) {}

  get(key: string): Entry<T> | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    // Bump to most-recently-used.
    this.store.delete(key);
    this.store.set(key, e);
    return e;
  }

  set(key: string, value: T): number {
    if (!this.store.has(key) && this.store.size >= this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    const at = Date.now();
    this.store.set(key, { value, at });
    return at;
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}
