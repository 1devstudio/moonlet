// A host's data is loaded with several requests while events keep coming.
// An event can overtake a reply sent before it, so the load must not undo
// it: what events changed during the load wins (X40).

import type { ReadRequest, TerminalInfo } from "@desktop/lib/protocol";
import type { ChatSummary, HostData } from "./app";

/** What events set (or removed, as null) while a load was running. */
export interface Touched {
  terminals: Map<number, TerminalInfo | null>;
  chats: Map<number, ChatSummary | null>;
  reads: Map<number, ReadRequest | null>;
}

export const touchedSince = (): Touched => ({ terminals: new Map(), chats: new Map(), reads: new Map() });

function apply<T>(base: Record<number, T>, touched: Map<number, T | null>): Record<number, T> {
  const out = { ...base };
  for (const [id, v] of touched) {
    if (v === null) delete out[id];
    else out[id] = v;
  }
  return out;
}

export function mergeLoaded(loaded: HostData, t: Touched): HostData {
  const reads = loaded.reads.filter((r) => !t.reads.has(r.request_id));
  for (const r of t.reads.values()) if (r) reads.push(r);
  return { ...loaded, terminals: apply(loaded.terminals, t.terminals), chats: apply(loaded.chats, t.chats), reads };
}
