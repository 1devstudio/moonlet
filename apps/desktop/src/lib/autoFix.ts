// Auto-fix pull requests (X117): the session's host sends its Claude the
// PR's failed checks and reviews. What the app shows of it.

import type { Session } from "./protocol";

/** The mark every message auto-fix sends starts with
 *  (`crates/moonlet-core/src/autofix.rs` writes the same mark). */
const MARK = "[Auto-fix] ";

/** A chat message auto-fix sent, without its mark, or null for the user's own. */
export function autoFixMessage(text: string): string | null {
  return text.startsWith(MARK) ? text.slice(MARK.length) : null;
}

/** The More menu's "Auto-fix this PR" for session `s` whose PR is `pr`,
 *  or null when it has no open PR. */
export function autoFixMenu(s: Session, pr: { state: string } | null | undefined): { checked: boolean; hint: string | null } | null {
  if (pr?.state !== "open") return null;
  const a = s.auto_fix;
  if (a?.stopped) return { checked: false, hint: `Auto-fix stopped after ${a.tries} tries` };
  return { checked: !!a?.on, hint: a?.note || null };
}

/** What to tell the user about sessions whose auto-fix just sent a
 *  message or stopped, between two lists of a host's sessions. */
export function autoFixNotices(before: readonly Session[], after: readonly Session[]): { session: string; text: string }[] {
  const was = new Map(before.map((s) => [s.id, s.auto_fix]));
  const out: { session: string; text: string }[] = [];
  for (const s of after) {
    const a = s.auto_fix;
    // A session the app had not loaded yet, as on reconnecting, is not news.
    if (!a || !was.has(s.id)) continue;
    const b = was.get(s.id);
    if (a.stopped && !b?.stopped) {
      out.push({ session: s.id, text: `Auto-fix stopped on #${a.pr} after ${a.tries} tries. Checks still fail.` });
    } else if (a.last && (a.last.kind !== b?.last?.kind || a.last.at !== b?.last?.at)) {
      const what = a.last.kind === "checks" ? "failed checks" : "new review";
      out.push({ session: s.id, text: `Auto-fix: sent #${a.pr}'s ${what} to ${s.name}` });
    }
  }
  return out;
}
