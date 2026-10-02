// User-level actions shared by buttons, menus, the command palette and
// keyboard shortcuts.

import { confirm } from "@tauri-apps/plugin-dialog";
import { rpc, sendInput } from "./daemon";
import { addTab, cycleFocus, splitLeaf, tabOf } from "./layout";
import { M, type SessionInfo, type Workspace } from "./protocol";
import { errorToast, getLayout, selectedWorkspace, setLayout, toast, useStore, workspaceSessions } from "./store";
import { findEntry } from "./terminals";

function current(): { host: string; ws: Workspace } | null {
  const s = useStore.getState();
  const ws = selectedWorkspace(s);
  return s.selected && ws ? { host: s.selected.host, ws } : null;
}

async function spawnShell(host: string, ws: Workspace, cwd?: string): Promise<SessionInfo> {
  const focused = getLayout(host, ws.id).focused;
  const entry = focused !== null ? findEntry(host, focused) : undefined;
  return rpc<SessionInfo>(host, M.sessionCreate, {
    cwd: cwd ?? entry?.cwd ?? ws.path,
    workspace_id: ws.id,
    cols: entry?.term.cols ?? 100,
    rows: entry?.term.rows ?? 30,
  });
}

export async function newTab() {
  const c = current();
  if (!c) return;
  try {
    // The session.created event would add a background tab; make it active instead.
    const info = await spawnShell(c.host, c.ws);
    const layout = getLayout(c.host, c.ws.id);
    const existing = tabOf(layout, info.id);
    setLayout(c.host, c.ws.id, existing ? { ...layout, active: existing.id, focused: info.id } : addTab(layout, info.id));
  } catch (e) {
    errorToast(e);
  }
}

export async function split(dir: "row" | "col") {
  const c = current();
  if (!c) return;
  const layout = getLayout(c.host, c.ws.id);
  const target = layout.focused;
  if (target === null) return newTab();
  try {
    const info = await spawnShell(c.host, c.ws);
    const l = getLayout(c.host, c.ws.id);
    // Remove the background tab the created-event may already have opened.
    const stray = tabOf(l, info.id);
    const tabs = l.tabs
      .filter((t) => t !== stray)
      .map((t) => (t.id === l.active ? { ...t, root: splitLeaf(t.root, target, info.id, dir) } : t));
    setLayout(c.host, c.ws.id, { ...l, tabs, focused: info.id });
  } catch (e) {
    errorToast(e);
  }
}

export async function closeFocused() {
  const c = current();
  if (!c) return;
  const focused = getLayout(c.host, c.ws.id).focused;
  if (focused === null) return;
  const info = useStore.getState().sessions[c.host]?.[focused];
  if (info?.kind === "agent" && !info.exit) {
    const ok = await confirm(`Stop the ${info.agent ?? "agent"} running in this tab?`, { title: "Close agent", kind: "warning" });
    if (!ok) return;
  }
  void rpc(c.host, M.sessionKill, { id: focused, remove: true }).catch(errorToast);
}

export function focusPane(delta: number) {
  const c = current();
  if (!c) return;
  const layout = getLayout(c.host, c.ws.id);
  const next = cycleFocus(layout, delta);
  if (next !== null) setLayout(c.host, c.ws.id, { ...layout, focused: next });
}

export function switchTab(delta: number) {
  const c = current();
  if (!c) return;
  const layout = getLayout(c.host, c.ws.id);
  if (!layout.tabs.length) return;
  const i = layout.tabs.findIndex((t) => t.id === layout.active);
  const tab = layout.tabs[(i + delta + layout.tabs.length) % layout.tabs.length];
  setLayout(c.host, c.ws.id, { ...layout, active: tab.id, focused: null });
}

/** The agent session of the selected workspace (first live one). */
export function agentSession(): { host: string; session: SessionInfo } | null {
  const c = current();
  if (!c) return null;
  const s = useStore.getState();
  const list = workspaceSessions(s, c.host, c.ws.id).filter((x) => x.kind === "agent" && !x.exit);
  const focused = getLayout(c.host, c.ws.id).focused;
  const pick = list.find((x) => x.id === focused) ?? list[0];
  return pick ? { host: c.host, session: pick } : null;
}

/**
 * Types text into the agent's TUI as a bracketed paste followed by Enter,
 * so multi-line prompts arrive as one message (task box, D3 comments).
 */
export async function sendToAgent(text: string): Promise<boolean> {
  const a = agentSession();
  if (!a) {
    toast("No running agent in this workspace", "error");
    return false;
  }
  await sendInput(a.host, a.session.id, `\x1b[200~${text}\x1b[201~`);
  setTimeout(() => void sendInput(a.host, a.session.id, "\r"), 60);
  return true;
}

export async function runScript(script: "run" | "setup") {
  const c = current();
  if (!c) return;
  try {
    const info = await rpc<SessionInfo>(c.host, M.wsRun, { id: c.ws.id, script, cols: 120, rows: 30 });
    const layout = getLayout(c.host, c.ws.id);
    const tab = tabOf(layout, info.id);
    setLayout(c.host, c.ws.id, tab ? { ...layout, active: tab.id, focused: info.id } : addTab(layout, info.id));
  } catch (e) {
    errorToast(e);
  }
}

export async function archiveWorkspace(deleteBranch = false) {
  const c = current();
  if (!c) return;
  const ok = await confirm(
    `Archive "${c.ws.name}"? Its terminals stop and the worktree folder is removed.${deleteBranch ? " The branch is deleted too." : " The branch is kept."}`,
    { title: "Archive workspace", kind: "warning" },
  );
  if (!ok) return;
  try {
    await rpc(c.host, M.wsArchive, { id: c.ws.id, remove_worktree: true, delete_branch: deleteBranch });
    useStore.setState({ selected: null });
    toast(`Archived ${c.ws.name}`);
  } catch (e) {
    errorToast(e);
  }
}

export function selectWorkspaceByIndex(i: number) {
  const s = useStore.getState();
  const hosts = Object.values(s.hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id));
  const flat: { host: string; id: string }[] = [];
  for (const h of hosts) {
    for (const r of s.repos[h.id] ?? []) {
      const list = (s.workspaces[h.id] ?? []).filter((w) => !w.archived && w.repo_id === r.id).sort((a, b) => a.created_at - b.created_at);
      flat.push(...list.map((w) => ({ host: h.id, id: w.id })));
    }
  }
  const t = flat[i];
  if (t) useStore.setState({ selected: { host: t.host, workspace: t.id } });
}

export function terminalSearch(query: string, backwards = false) {
  const c = current();
  if (!c) return false;
  const focused = getLayout(c.host, c.ws.id).focused;
  const e = focused !== null ? findEntry(c.host, focused) : undefined;
  if (!e || !query) return false;
  const opts = { decorations: { matchOverviewRuler: "#7c9cff", activeMatchColorOverviewRuler: "#f2b84b", matchBackground: "#3a4a6b", activeMatchBackground: "#7a5a1e" } };
  return backwards ? e.search.findPrevious(query, opts) : e.search.findNext(query, opts);
}

export function focusedEntry() {
  const c = current();
  if (!c) return undefined;
  const focused = getLayout(c.host, c.ws.id).focused;
  return focused !== null ? findEntry(c.host, focused) : undefined;
}
