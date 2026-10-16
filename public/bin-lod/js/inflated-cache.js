/**
 * LRU cache with per-key pinning for inflated G1BK cells.
 * Eviction only occurs on trim() for unpinned keys.
 */
export class InflatedCache {
  constructor(max = 256) {
    this.max = max;
    this.cache = new Map(); // key -> value (order: oldest first)
    this.pins = new Map();  // key -> refcount
  }

  get size() {
    return this.cache.size;
  }

  has(key) {
    return this.cache.has(key);
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
  }

  pin(keys) {
    for (const k of keys) {
      this.pins.set(k, (this.pins.get(k) || 0) + 1);
    }
  }

  unpin(keys) {
    for (const k of keys) {
      const count = this.pins.get(k);
      if (count !== undefined) {
        if (count === 1) this.pins.delete(k);
        else this.pins.set(k, count - 1);
      }
    }
  }

  trim() {
    let evicted = 0;
    for (const k of [...this.cache.keys()]) {
      if (this.cache.size <= this.max) break;
      if (this.pins.has(k)) continue;
      this.cache.delete(k);
      evicted++;
    }
    return evicted;
  }
}
