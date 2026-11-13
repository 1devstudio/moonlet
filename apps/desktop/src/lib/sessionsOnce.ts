// A session moving between two members of an account is, for a moment,
// listed by both (X73). Wherever the app lists sessions from several of
// them, each shows once. A session keeps its id across the account's
// members (X72), so the same id on two of them is the same session.

import { parseCopyHost } from "./copyHost";
import type { Session } from "./protocol";

/** `lists`, in order, with each item in the first list that holds its
 * `id` only: later lists, and repeats within one, leave it out. */
export function firstListings<T>(lists: T[][], id: (item: T) => string): T[][] {
  const seen = new Set<string>();
  return lists.map((list) => {
    const out: T[] = [];
    for (const item of list) {
      const key = id(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  });
}

/** Every live session the app lists, by host in order, each once (X73):
 * from the first host that lists it, and never from a central host's copy
 * of one a host lists as its own (X88). */
export function sessionsOnce(sessions: Record<string, Session[]>): { host: string; session: Session }[] {
  const own = new Set(
    Object.entries(sessions)
      .filter(([host]) => !parseCopyHost(host))
      .flatMap(([, list]) => list.map((s) => s.id)),
  );
  const lists = Object.entries(sessions).map(([host, list]) =>
    list.filter((s) => !s.archived && (!parseCopyHost(host) || !own.has(s.id))).map((session) => ({ host, session })),
  );
  return firstListings(lists, (e) => e.session.id).flat();
}
