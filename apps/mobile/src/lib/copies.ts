// Sessions another member owns, listed by the central host the phone is
// paired with (X72). The phone opens one under its copy host
// (@desktop/lib/copyHost), so its calls go through the central host.

import type { ChatState, Session, TerminalInfo } from "@desktop/lib/protocol";
import type { ChatSummary, HostData } from "./app";

/** Where a session another member owns runs, for its row; null for the
 * host's own. */
export function ownerLine(s: Session): string | null {
  if (!s.owner) return null;
  return s.owner.reachable ? `on ${s.owner.name}` : `${s.owner.name} is asleep`;
}

/** The line above the composer while the session's member is away. */
export function readOnlyLine(s: Session, central: string): string | null {
  if (!s.owner || s.owner.reachable) return null;
  return `${s.owner.name} is asleep. This is the copy on ${central}, read only.`;
}

/** What the phone shows of copy host session `id`: the central host's
 * data, with the session holding the terminals and chats its member gave
 * (`terminal.list` and `chat.summaries` through the central host). */
export function copyData(
  central: HostData,
  id: string,
  terminals: TerminalInfo[],
  chats: { id: number; state: ChatSummary | ChatState }[],
): HostData | null {
  const session = central.sessions.find((s) => s.id === id);
  if (!session) return null;
  const ids = [...new Set([...terminals.map((t) => t.id), ...chats.map((c) => c.id)])];
  // While the member is away there is no terminal list: each chat the copy
  // holds stands for its terminal, so the Chat tab still finds it.
  const known = new Set(terminals.map((t) => t.id));
  const standIns: TerminalInfo[] = chats
    .filter((c) => !known.has(c.id))
    .map((c) => ({
      id: c.id,
      kind: "agent",
      title: "Claude",
      cwd: session.path,
      command: [],
      session_id: id,
      agent_state: "idle",
      cols: 80,
      rows: 24,
      pid: null,
      chat: true,
      created_at: session.created_at,
      last_output_at: 0,
    }));
  return {
    ...central,
    sessions: [{ ...session, terminals: ids }],
    terminals: Object.fromEntries([...terminals, ...standIns].map((t) => [t.id, t])),
    chats: Object.fromEntries(chats.map((c) => [c.id, c.state as ChatSummary])),
    reads: [],
    copies: [],
    setups: [],
  };
}

/** Each host's sessions, without the copies of sessions another connected
 * host lists as its own: the phone paired with both the MacBook and the
 * central host shows a session once, from the MacBook. */
export function dropRelisted(sessions: Record<string, Session[]>): Record<string, Session[]> {
  const own = new Set(
    Object.values(sessions)
      .flat()
      .filter((s) => !s.owner)
      .map((s) => s.id),
  );
  return Object.fromEntries(Object.entries(sessions).map(([host, list]) => [host, list.filter((s) => !s.owner || !own.has(s.id))]));
}
