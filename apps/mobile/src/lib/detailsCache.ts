// A small cache for row details the daemon sends no events about (a
// session's diff stat and PR, a project's base branch, X40): a value is kept
// for `ttl`, and rows asking at the same time share one load.

export function detailsCache(ttl: number, now: () => number = Date.now) {
  const values = new Map<string, { at: number; value: unknown }>();
  const loading = new Map<string, Promise<unknown>>();
  return {
    load<T>(key: string, f: () => Promise<T>, force = false): Promise<T> {
      const hit = values.get(key);
      if (!force && hit && now() - hit.at < ttl) return Promise.resolve(hit.value as T);
      const running = loading.get(key);
      if (running) return running as Promise<T>;
      const p = f()
        .then((value) => {
          values.set(key, { at: now(), value });
          return value;
        })
        .finally(() => loading.delete(key));
      loading.set(key, p);
      return p;
    },
    /** The value kept for `key`, if any. */
    peek<T>(key: string): T | undefined {
      return values.get(key)?.value as T | undefined;
    },
    /** Drops the values of every key starting with `prefix`. */
    forget(prefix: string) {
      for (const k of values.keys()) if (k.startsWith(prefix)) values.delete(k);
    },
  };
}
