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
  return {
    ...central,
    sessions: [{ ...session, terminals: ids }],
    terminals: Object.fromEntries(terminals.map((t) => [t.id, t])),
    chats: Object.fromEntries(chats.map((c) => [c.id, c.state as ChatSummary])),
    reads: [],
    copies: [],
    setups: [],
  };
}
