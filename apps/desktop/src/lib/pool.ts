// A pool for bulk actions (X106): at most `limit` run at once, the next
// starting as one ends, in the order given. One that fails does not stop
// the rest; each result says how it went.

export type Pooled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The most bulk actions moonlet runs at once: archiving or moving five
 * sessions together, not fifty, keeps a host's git and load in check. */
export const BULK_LIMIT = 5;

export async function runPooled<I, T>(items: I[], limit: number, run: (item: I, index: number) => Promise<T>): Promise<Pooled<T>[]> {
  const results: Pooled<T>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await run(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
