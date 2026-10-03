// User-level actions shared by buttons, menus, the command palette and
// keyboard shortcuts.

import { confirm } from "@tauri-apps/plugin-dialog";
import { rpc, sendInput } from "./daemon";
import { addTab, cycleFocus, splitLeaf, tabOf } from "./layout";
import { M, type TerminalInfo, type Session } from "./protocol";
import { errorToast, getLayout, selectedSession, setLayout, toast, useStore, sessionTerminals } from "./store";
import { findEntry } from "./terminals";
import { isStructured } from "./agents";

function current(): { host: string; ws: Session } | null {
  const s = useStore.getState();
  const ws = selectedSession(s);
  return s.selected && ws ? { host: s.selected.host, ws } : null;
}

async function spawnShell(host: string, ws: Session, cwd?: string): Promise<TerminalInfo> {
  const focused = getLayout(host, ws.id).focused;
  const entry = focused !== null ? findEntry(host, focused) : undefined;
  return rpc<TerminalInfo>(host, M.terminalCreate, {
    cwd: cwd ?? entry?.cwd ?? ws.path,
    session_id: ws.id,
    classic: useStore.getState().settings.term.classicPrompt,
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

/** Opens another agent (or a shell) as a new tab in the selected workspace. */
export async function newAgentTab(agent: string) {
  const c = current();
  if (!c) return;
  try {
    const info = await rpc<TerminalInfo>(c.host, M.terminalCreate, { cwd: c.ws.path, session_id: c.ws.id, kind: "agent", agent, chat: isStructured(agent), cols: 120, rows: 32 });
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
  const info = useStore.getState().terminals[c.host]?.[focused];
  if (info?.kind === "agent" && !info.exit) {
    const ok = await confirm(`Stop the ${info.agent ?? "agent"} running in this tab?`, { title: "Close agent", kind: "warning" });
    if (!ok) return;
  }
  void rpc(c.host, M.terminalKill, { id: focused, remove: true }).catch(errorToast);
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
export function agentSession(): { host: string; session: TerminalInfo } | null {
  const c = current();
  if (!c) return null;
  const s = useStore.getState();
  const list = sessionTerminals(s, c.host, c.ws.id).filter((x) => x.kind === "agent" && !x.exit);
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
    toast("No running agent in this session", "error");
    return false;
  }
  if (a.session.chat) {
    // Structured agents take messages, not keystrokes (X6).
    try {
      await rpc(a.host, M.chatSend, { id: a.session.id, text });
    } catch (e) {
      errorToast(e);
      return false;
    }
    return true;
  }
  await sendInput(a.host, a.session.id, `\x1b[200~${text}\x1b[201~`);
  setTimeout(() => void sendInput(a.host, a.session.id, "\r"), 60);
  return true;
}

/** Switches a shell between Warp mode and its own prompt (T7). */
export async function setClassic(host: string, id: number, classic: boolean) {
  try {
    const info = await rpc<TerminalInfo>(host, M.terminalSetClassic, { id, classic });
    // An empty Enter redraws the prompt in the new mode right away.
    if (info.prompt) void sendInput(host, id, "\r");
  } catch (e) {
    errorToast(e);
  }
}

export async function runScript(script: "run" | "setup") {
  const c = current();
  if (!c) return;
  try {
    const info = await rpc<TerminalInfo>(c.host, M.sessionRun, { id: c.ws.id, script, cols: 120, rows: 30 });
    const layout = getLayout(c.host, c.ws.id);
    const tab = tabOf(layout, info.id);
    setLayout(c.host, c.ws.id, tab ? { ...layout, active: tab.id, focused: info.id } : addTab(layout, info.id));
  } catch (e) {
    errorToast(e);
  }
}

export async function archiveSession(deleteBranch = false) {
  const c = current();
  if (!c) return;
  const ok = await confirm(
    `Archive "${c.ws.name}"? Its terminals stop and the worktree folder is removed.${deleteBranch ? " The branch is deleted too." : " The branch is kept."}`,
    { title: "Archive session", kind: "warning" },
  );
  if (!ok) return;
  try {
    await rpc(c.host, M.sessionArchive, { id: c.ws.id, remove_worktree: true, delete_branch: deleteBranch });
    useStore.setState({ selected: null });
    toast(`Archived ${c.ws.name}`);
  } catch (e) {
    errorToast(e);
  }
}

export function selectSessionByIndex(i: number) {
  const s = useStore.getState();
  const hosts = Object.values(s.hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id));
  const flat: { host: string; id: string }[] = [];
  for (const h of hosts) {
    for (const r of s.projects[h.id] ?? []) {
      const list = (s.sessions[h.id] ?? []).filter((w) => !w.archived && w.project_id === r.id).sort((a, b) => b.created_at - a.created_at);
      flat.push(...list.map((w) => ({ host: h.id, id: w.id })));
    }
  }
  const t = flat[i];
  if (t) useStore.setState({ selected: { host: t.host, session: t.id } });
}

export function terminalSearch(query: string, backwards = false) {
  const c = current();
  if (!c) return false;
  const focused = getLayout(c.host, c.ws.id).focused;
  const e = focused !== null ? findEntry(c.host, focused) : undefined;
  if (!e || !query) return false;
  const opts = { decorations: { matchOverviewRuler: "#d97757", activeMatchColorOverviewRuler: "#f2c94c", matchBackground: "#5a3a2a", activeMatchBackground: "#7a5a1e" } };
  return backwards ? e.search.findPrevious(query, opts) : e.search.findNext(query, opts);
}

export function focusedEntry() {
  const c = current();
  if (!c) return undefined;
  const focused = getLayout(c.host, c.ws.id).focused;
  return focused !== null ? findEntry(c.host, focused) : undefined;
}
