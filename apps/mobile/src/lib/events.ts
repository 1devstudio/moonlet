// What a daemon event changes in a host's data (X40). The same changes are
// applied to the data shown and, when they arrive while a load is on its
// way, to the load's result: an event can overtake a reply sent before it.

import { EV, type AccountInfo, type ChatState, type CopyChanged, type ExecSetup, type GitSettings, type ReadRequest, type TerminalInfo } from "@desktop/lib/protocol";
import { DaemonError } from "@desktop/lib/daemon";
import type { TaskSnapshot } from "@desktop/lib/taskSnapshot";
import type { ChatSummary, HostData } from "./app";

/** One record set, or removed (null). */
export type Change =
  | { kind: "terminals"; id: number; value: TerminalInfo | null }
  | { kind: "chats"; id: number; value: ChatSummary | null }
  | { kind: "reads"; id: number; value: ReadRequest | null }
  | { kind: "git"; value: GitSettings }
  | { kind: "account"; value: string }
  /** A live copy (X60), or removed when it went. */
  | { kind: "copy"; id: string; value: Omit<CopyChanged, "newly_differing" | "removed"> | null }
  /** A routing copy's setup waiting for approval (X62), or answered (null). */
  | { kind: "setup"; copy: string; value: ExecSetup | null }
  /** A workspace's board snapshot (X76), or removed with its workspace. */
  | { kind: "tasks"; workspace: string; value: TaskSnapshot | null }
  /** moonlet opened or closed on the Mac (X76). */
  | { kind: "macOpen"; value: boolean };

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
    case EV.syncChanged: {
      const { newly_differing: _n, removed, ...copy } = data as CopyChanged;
      return [{ kind: "copy", id: copy.id, value: removed ? null : copy }];
    }
    case EV.execSetup: {
      const ask = data as ExecSetup;
      return [{ kind: "setup", copy: ask.copy, value: ask }];
    }
    case EV.accountInfo:
      return [{ kind: "account", value: (data as AccountInfo).account }];
    case EV.tasksApp:
      return [{ kind: "macOpen", value: (data as { open: boolean }).open }];
    case EV.tasksChanged: {
      const { workspace, snapshot } = data as { workspace: string; snapshot: TaskSnapshot | null };
      return [{ kind: "tasks", workspace, value: snapshot }];
    }
    case EV.sessionsChanged:
    case EV.projectsChanged:
    case EV.workspacesChanged:
    case EV.sectionsChanged:
      return "reload";
    default:
      return [];
  }
}

/** What a failed `git.settings` leaves (X55): no settings for a daemon too
 * old to have them, else the ones already loaded. */
export function gitAfterError(e: unknown): null | "keep" {
  return e instanceof DaemonError && e.code === "unknown_method" ? null : "keep";
}

/** What a failed `account.get` leaves (X68): no account, so the host is its
 * own, for a daemon too old to have one, else the one already known. */
export function accountAfterError(e: unknown): null | "keep" {
  return gitAfterError(e);
}

/** `list` without the items `same` picks, then `value` last, if any. */
function replaceBy<T>(list: T[], same: (x: T) => boolean, value: T | null): T[] {
  const rest = list.filter((x) => !same(x));
  return value ? [...rest, value] : rest;
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
    else if (c.kind === "account") out = { ...out, account: c.value };
    else if (c.kind === "copy") out = { ...out, copies: replaceBy(out.copies, (x) => x.id === c.id, c.value) };
    else if (c.kind === "setup") out = { ...out, setups: replaceBy(out.setups, (x) => x.copy === c.copy, c.value) };
    else if (c.kind === "macOpen") out = { ...out, macOpen: c.value };
    else if (c.kind === "tasks") {
      const tasks = { ...out.tasks };
      if (c.value) tasks[c.workspace] = c.value;
      else delete tasks[c.workspace];
      out = { ...out, tasks };
    } else out = { ...out, reads: replaceBy(out.reads, (r) => r.request_id === c.id, c.value) };
  }
  return out;
}
