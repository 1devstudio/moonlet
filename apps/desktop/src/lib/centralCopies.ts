// The sessions other members run, in the central host's own app (X86). Its
// daemon holds a copy of each (X72); the app lists them from it and opens
// each under its copy host, so its calls go to the member running it.

import { copyHostId, parseCopyHost } from "./copyHost";
import type { AccountInfo, Session, TerminalInfo } from "./protocol";

/** The copy hosts to list from this Mac's daemon's `session.list
 * {copies: true}`, each with its session: none unless the daemon is a
 * central host (its account names no central host), and never a session
 * this Mac runs itself. */
export function copyEntries(list: Session[], account: AccountInfo | undefined): Record<string, Session[]> {
  if (!account || account.central !== null) return {};
  return Object.fromEntries(list.filter((s) => s.owner && s.owner.worker !== account.account).map((s) => [copyHostId("local", s.id), [s]]));
}

/** What copy `session` shows once opened: the terminals its member lists
 * through the central host (`terminal.list`), and, while that member is
 * away and lists none, a stand-in agent terminal for each chat the copy
 * holds (`chats`, from `chat.summaries`), so its chat tab still opens. */
export function copyView(session: Session, terminals: TerminalInfo[], chats: number[]): { session: Session; terminals: TerminalInfo[] } {
  const known = new Set(terminals.map((t) => t.id));
  const standIns: TerminalInfo[] = chats
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      kind: "agent",
      title: "Claude",
      cwd: session.path,
      command: [],
      session_id: session.id,
      agent_state: "idle",
      cols: 80,
      rows: 24,
      pid: null,
      chat: true,
      created_at: session.created_at,
      last_output_at: 0,
    }));
  const all = [...terminals, ...standIns];
  return { session: { ...session, terminals: all.map((t) => t.id) }, terminals: all };
}

/** What the session view offers for a session opened under `host`: a copy
 * of another member's session (X86) offers none of what that member
 * refuses through the central host (X72), and its folder here is a read
 * only copy, never opened in another app. */
export function copyOffers(host: string): { files: boolean; newTabs: boolean; processes: boolean; projectSettings: boolean; setup: boolean; openIn: boolean } {
  const ok = !parseCopyHost(host);
  return { files: ok, newTabs: ok, processes: ok, projectSettings: ok, setup: ok, openIn: ok };
}

/** Why a copy (X86) does not do `action` when a shortcut or the command
 * palette asks it to: where to do it instead. */
export const copyRefused = (s: Session, action: string) => `${s.name} runs on ${s.owner?.name ?? "another Mac"}: ${action} there.`;

/** The line above the composer while the session's member is away. */
export function readOnlyLine(s: Session, central: string): string | null {
  if (!s.owner || s.owner.reachable) return null;
  return `${s.owner.name} is asleep. This is the copy on ${central}, read only.`;
}

/** How long the central host waits after a member becomes unreachable
 * before it continues that member's sessions (X73). */
const CONTINUE_AFTER_MS = 30_000;

/** Seconds left at `now` (ms) before Continue on <central> can be pressed:
 * the central host continues a session only once its member has been
 * unreachable for 30 s (X73). 0 once it can, or when the central host does
 * not say since when the member is away. */
export function continueWait(s: Session, now: number): number {
  const since = s.owner?.unreachable_since;
  if (since == null) return 0;
  return Math.max(0, Math.ceil((since + CONTINUE_AFTER_MS - now) / 1000));
}

/** The button that continues a session on the central host while its
 * member is unreachable (X73), counting down the seconds until it can be
 * pressed; none while it is reachable, or kept there. */
export function continueOffer(s: Session, central: string, now = Date.now()): string | null {
  if (!s.owner || s.owner.reachable || s.pinned) return null;
  const wait = continueWait(s, now);
  return wait > 0 ? `Continue on ${central} in ${wait} s` : `Continue on ${central}`;
}

/** What the app says when Continue on <central> failed (X73), by the
 * central host's error: the member came back, the session is kept on it,
 * the central host holds no copy yet, or the request did not get through. */
export function continueFailed(e: unknown, s: Session, central: string): string {
  const code = e && typeof e === "object" && "code" in e ? String(e.code) : null;
  const owner = s.owner?.name ?? "its member";
  if (code === "reachable") return `${owner} is back: ${s.name} goes on there.`;
  if (code === "pinned") return `${s.name} is kept on ${owner}.`;
  if (code === "no_copy") return `${central} has no copy of ${s.name} yet.`;
  const message = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  return `Could not continue on ${central}: ${message}`;
}
