/**
 * A capped TTL memo over the public namespace. The public surface is
 * saved-searches-only, so its response set is finite and enumerable — the
 * strongest lever against an anonymous caller running the same expensive query
 * repeatedly is making the second call free rather than counting the first.
 */
export class PublicCache<T> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs: number, maxEntries = 500) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  async get(key: string, compute: () => T | Promise<T>): Promise<T> {
    if (this.#ttlMs <= 0) return compute();

    const hit = this.#entries.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value;

    const value = await compute();
    // Oldest insertion order stands in for LRU here: a Map preserves insertion
    // order, and a memo over a finite, saved-search-only surface never needs
    // real recency tracking to stay useful.
    if (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
    return value;
  }
}
