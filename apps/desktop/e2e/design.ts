// Helpers of the design editor's e2e specs (X65): a key pressed on the app,
// a page file waited for on disk, and a promise given a deadline.
import { browser } from "@wdio/globals";

/** A key pressed on the app, outside any field, as the keyboard sends it. */
export async function press(key: string, init: { code?: string; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) {
  await browser.execute(
    (k: string, m: object) => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m }));
    },
    key,
    init,
  );
}

/** Waits until the file `read` gives passes `ok`; the timeout names `what`. */
export const diskShows = (read: () => string, ok: (html: string) => boolean, what: string) => browser.waitUntil(() => ok(read()), { timeoutMsg: `the page file never ${what}:\n${read()}` });

/** `p`'s value, or "timed out" when it takes longer than `ms`. */
export const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<"timed out">((r) => setTimeout(() => r("timed out"), ms))]);
