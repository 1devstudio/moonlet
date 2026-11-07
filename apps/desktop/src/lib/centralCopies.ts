// The sessions other members run, in the central host's own app (X86). Its
// daemon holds a copy of each (X72); the app lists them from it and opens
// each under its copy host, so its calls go to the member running it.

import { copyHostId } from "./copyHost";
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
