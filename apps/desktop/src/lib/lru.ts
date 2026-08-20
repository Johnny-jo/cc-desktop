/** Insertion-order LRU. `get` refreshes recency. */
export function createLru<K, V>(max: number): {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  get size(): number;
} {
  const cap = Math.max(1, max);
  const map = new Map<K, V>();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    has(key) {
      return map.has(key);
    },
    get size() {
      return map.size;
    },
  };
}
