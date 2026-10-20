// What a daemon event changes in a host's data (X40). The same changes are
// applied to the data shown and, when they arrive while a load is on its
// way, to the load's result: an event can overtake a reply sent before it.

import { EV, type ChatState, type GitSettings, type ReadRequest, type TerminalInfo } from "@desktop/lib/protocol";
import type { ChatSummary, HostData } from "./app";

/** One record set, or removed (null). */
export type Change =
  | { kind: "terminals"; id: number; value: TerminalInfo | null }
  | { kind: "chats"; id: number; value: ChatSummary | null }
  | { kind: "reads"; id: number; value: ReadRequest | null }
  | { kind: "git"; value: GitSettings };

/** The changes `name` makes, or "reload" when only a fresh load tells. */
export function eventChanges(name: string, data: unknown): Change[] | "reload" {
  switch (name) {
    case EV.terminalCreated:
    case EV.terminalUpdated:
    case EV.terminalExited: {
      const t = data as TerminalInfo;
      return [{ kind: "terminals", id: t.id, value: t }];
    }
    case EV.terminalRemoved: {
      const id = (data as { id: number }).id;
      return [
        { kind: "terminals", id, value: null },
        { kind: "chats", id, value: null },
      ];
    }
    case EV.chatState: {
      const { id, state } = data as { id: number; state: ChatState };
      const { items: _items, ...summary } = state;
      return [{ kind: "chats", id, value: summary }];
    }
    case EV.terminalReadRequest:
      return [{ kind: "reads", id: (data as ReadRequest).request_id, value: data as ReadRequest }];
    case EV.terminalReadDone:
      return [{ kind: "reads", id: (data as { request_id: number }).request_id, value: null }];
    case EV.gitSettingsChanged:
      return [{ kind: "git", value: data as GitSettings }];
    case EV.sessionsChanged:
    case EV.projectsChanged:
    case EV.workspacesChanged:
    case EV.sectionsChanged:
      return "reload";
    default:
      return [];
  }
}

function setRecord<T>(base: Record<number, T>, id: number, value: T | null): Record<number, T> {
  const out = { ...base };
  if (value === null) delete out[id];
  else out[id] = value;
  return out;
}

export function applyChanges(d: HostData, changes: readonly Change[]): HostData {
  let out = d;
  for (const c of changes) {
    if (c.kind === "terminals") out = { ...out, terminals: setRecord(out.terminals, c.id, c.value) };
    else if (c.kind === "chats") out = { ...out, chats: setRecord(out.chats, c.id, c.value) };
    else if (c.kind === "git") out = { ...out, git: c.value };
    else {
      const reads = out.reads.filter((r) => r.request_id !== c.id);
      out = { ...out, reads: c.value ? [...reads, c.value] : reads };
    }
  }
  return out;
}
