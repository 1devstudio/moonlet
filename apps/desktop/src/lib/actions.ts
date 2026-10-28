// User-level actions shared by buttons, menus, the command palette and
// keyboard shortcuts.

import { rpc, sendInput } from "./daemon";
import { addTab, closeFile, closeJob, cycleFocus, openFile, openJob, splitLeaf, tabOf } from "./layout";
import { M, type ProjectConfig, type TerminalInfo, type Session, type SessionArchived, type UnpushedWork } from "./protocol";
import { checkForUpdates, errorToast, focusTerminal, getLayout, selectedSession, sesKey, sessionState, setLayout, termKey, toast, useStore, sessionTerminals, shownWorkspace, designHostOf } from "./store";
import { lastActive, sharedSessionOrder } from "./sidebar";
import { findEntry, outputToCopy } from "./terminals";
import { agentReadiness, isStructured, tabAgent } from "./agents";
import { hasRunCommand } from "./projectSettings";
import { ARCHIVE_FOLD_MS, ARCHIVE_MIN_MS, type Archiving, pickLoader } from "./archiveLoader";
import { archivePrompt, askConfirm, unpushedPrompt } from "./confirm";
import { archiveFlags, archivePlan, gitSettingsOf, unpushedParams, unpushedView } from "./gitSettings";
import { goSettings } from "./settingsNavigation";
import { setMode, toggleMode } from "./mode";
import { openNewDesign } from "./designStore";

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
export async function newAgentTab(agent: string): Promise<TerminalInfo | null> {
  const c = current();
  if (!c) return null;
  try {
    const info = await rpc<TerminalInfo>(c.host, M.terminalCreate, { cwd: c.ws.path, session_id: c.ws.id, kind: "agent", agent, chat: isStructured(agent), cols: 120, rows: 32 });
    const layout = getLayout(c.host, c.ws.id);
    const existing = tabOf(layout, info.id);
    setLayout(c.host, c.ws.id, existing ? { ...layout, active: existing.id, focused: info.id } : addTab(layout, info.id));
    return info;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

/** ⌘T (X38): a new tab with the session's agent. */
export async function newSessionAgentTab() {
  const c = current();
  if (c) await newAgentTab(tabAgent(c.ws.agent));
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
  const layout = getLayout(c.host, c.ws.id);
  const root = layout.tabs.find((t) => t.id === layout.active)?.root;
  if (root?.type === "file") return closeFileTab(c.host, c.ws.id, root.path);
  if (root?.type === "job") return closeJobTab(c.host, c.ws.id, root.job);
  const focused = layout.focused;
  if (focused === null) return;
  const info = useStore.getState().terminals[c.host]?.[focused];
  if (info?.kind === "agent" && !info.exit) {
    if (!(await confirmStopAgent(info.agent))) return;
  }
  void rpc(c.host, M.terminalKill, { id: focused, remove: true }).catch(errorToast);
}

/** Closes a tab's terminals, asking first if an agent is still running. */
export async function closeTab(host: string, ids: number[]) {
  const terms = useStore.getState().terminals[host] ?? {};
  const agents = ids.map((id) => terms[id]).filter((t) => t?.kind === "agent" && !t.exit);
  if (agents.length) {
    if (!(await confirmStopAgent(agents[0]?.agent))) return;
  }
  for (const id of ids) void rpc(host, M.terminalKill, { id, remove: true }).catch(errorToast);
}

/** Opens a file in an editor tab of a session's main window (X26), at `line` if given. */
export function openFileTab(host: string, wsId: string, path: string, line?: number) {
  setLayout(host, wsId, openFile(getLayout(host, wsId), path, line));
}

/** Closes a file's editor tab, asking first when it has unsaved edits. */
export async function closeFileTab(host: string, wsId: string, path: string) {
  const key = `${host}|${path}`;
  if (useStore.getState().dirtyFiles[key]) {
    const name = path.split("/").pop();
    const ok = await askConfirm({ title: "Unsaved changes", message: `Discard unsaved changes to ${name}?`, action: "Discard", variant: "danger" });
    if (!ok) return;
  }
  setLayout(host, wsId, closeFile(getLayout(host, wsId), path));
  useStore.setState((s) => {
    const dirtyFiles = { ...s.dirtyFiles };
    delete dirtyFiles[key];
    return { dirtyFiles };
  });
}

function confirmStopAgent(agent: string | null | undefined) {
  return askConfirm({ title: "Close agent", message: `Stop the ${agent ?? "agent"} running in this tab?`, action: "Stop agent" });
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

/**
 * Puts `text` into an agent's input without submitting it (T8): the
 * session's running agent, or a new agent tab when there is none or
 * `newTab` is set. Structured agents get it in their composer; TUI agents
 * as a bracketed paste. Focus moves to the agent.
 */
export async function draftToAgent(text: string, newTab = false) {
  const c = current();
  if (!c) return;
  let target = newTab ? null : agentSession()?.session ?? null;
  if (!target) {
    target = await newAgentTab(tabAgent(c.ws.agent));
    if (!target) return;
    // A TUI agent reads its input once it has drawn its first screen.
    if (!target.chat && !(await waitForAgent(c.host, target.id))) {
      toast("The agent exited before the block could be sent", "error");
      return;
    }
  }
  if (target.chat) useStore.setState((s) => ({ agentDrafts: { ...s.agentDrafts, [termKey(c.host, target.id)]: text } }));
  else await sendInput(c.host, target.id, `\x1b[200~${text}\x1b[201~`);
  focusTerminal(c.host, target.id);
}

/** Resolves true once a new TUI agent has drawn its first screen, or false
 * if it exits or is removed first. There is no timeout: a slow agent still
 * gets the draft once it is ready. */
function waitForAgent(host: string, id: number): Promise<boolean> {
  const started = Date.now();
  let seen = false;
  return new Promise((resolve) => {
    const tick = () => {
      const t = useStore.getState().terminals[host]?.[id];
      // The terminal.created event may not have reached the store yet.
      seen ||= !!t;
      const state = !seen && Date.now() - started < 30_000 ? "waiting" : agentReadiness(t);
      if (state === "waiting") setTimeout(tick, 100);
      else resolve(state === "ready");
    };
    tick();
  });
}

/** Switches a shell between Blocks mode and its own prompt (T7). */
export async function setClassic(host: string, id: number, classic: boolean) {
  try {
    const info = await rpc<TerminalInfo>(host, M.terminalSetClassic, { id, classic });
    // An empty Enter redraws the prompt in the new mode right away. Leaving
    // Classic, the shell line may hold a half-typed command: Ctrl+U clears
    // it first (it stays in the shell's kill ring) so Enter cannot run it.
    if (info.prompt) void sendInput(host, id, classic ? "\r" : "\x15\r");
  } catch (e) {
    errorToast(e);
  }
}

/** Opens Project settings for `target`, or the selected session's project. */
export function openProjectSettings(target?: { host: string; project: string }, focus?: "run") {
  const c = current();
  const t = target ?? (c && { host: c.host, project: c.ws.project_id });
  if (t) void goSettings(focus ? { page: "project", host: t.host, id: t.project, focus } : { page: "project", host: t.host, id: t.project });
}

export async function runScript(script: "run" | "setup") {
  const c = current();
  if (!c) return;
  try {
    // No run command yet: offer to set one instead of failing (X8).
    if (script === "run") {
      const config = await rpc<ProjectConfig>(c.host, M.projectConfig, { id: c.ws.project_id });
      if (!hasRunCommand(config)) return openProjectSettings(undefined, "run");
    }
    const info = await rpc<TerminalInfo>(c.host, M.sessionRun, { id: c.ws.id, script, cols: 120, rows: 30 });
    const layout = getLayout(c.host, c.ws.id);
    const tab = tabOf(layout, info.id);
    setLayout(c.host, c.ws.id, tab ? { ...layout, active: tab.id, focused: info.id } : addTab(layout, info.id));
  } catch (e) {
    errorToast(e);
  }
}

/** Archives `target`, or the selected session, once confirmed. The host's
 * Git settings and the session's PR decide what happens to its folder and
 * branch (X55), or the confirm modal's checkbox for "Ask each time" (X23). */
export async function archiveSession(target?: { host: string; ws: Session }) {
  const c = target ?? current();
  if (!c) return;
  const s = useStore.getState();
  const base = s.projects[c.host]?.find((p) => p.id === c.ws.project_id)?.base_branch ?? c.ws.base;
  const git = gitSettingsOf(s.gitSettings, c.host);
  const pr = s.prs[sesKey(c.host, c.ws.id)];
  const plan = archivePlan(git, pr?.state, c.ws.branch, base);
  // Work only on this machine that the archive would take (X55).
  const where = c.host === "local" ? "this Mac" : (s.hosts[c.host]?.label ?? c.host);
  const params = unpushedParams(c.ws, pr);
  const work = git.warn_unpushed ? await rpc<UnpushedWork>(c.host, M.gitUnpushed, params).catch(() => null) : null;
  const view = work && unpushedView(work, plan, c.ws.branch, where);
  const answer = await askConfirm(view ? unpushedPrompt(c.ws.name, plan, view) : archivePrompt(c.ws.name, plan));
  if (!answer) return;
  const flags = archiveFlags(plan, answer.checked, !!answer.alt);
  if (answer.alt) {
    try {
      await rpc(c.host, M.gitPush, params);
    } catch (e) {
      errorToast(e);
      return;
    }
  }
  // Close its views first: they would reload while the worktree is deleted.
  const sel = useStore.getState().selected;
  const wasSelected = sel?.host === c.host && sel.session === c.ws.id;
  if (wasSelected) useStore.setState({ selected: null });
  // The row plays a pixel scene while the daemon works, then folds away (X21).
  const key = sesKey(c.host, c.ws.id);
  const loader = pickLoader();
  const started = Date.now();
  setArchiving(key, { loader, done: false, folding: false });
  try {
    const done = await rpc<SessionArchived | boolean>(c.host, M.sessionArchive, { id: c.ws.id, ...flags });
    if (typeof done === "object" && done.remote_error) toast(`Couldn't delete ${c.ws.branch} on origin: ${done.remote_error}`, "error");
    setArchiving(key, { loader, done: true, folding: false });
    await sleep(ARCHIVE_MIN_MS - (Date.now() - started));
    setArchiving(key, { loader, done: true, folding: true });
    await sleep(ARCHIVE_FOLD_MS);
    setArchiving(key, null);
    toast(`Archived ${c.ws.name}`);
  } catch (e) {
    setArchiving(key, null);
    if (wasSelected && !useStore.getState().selected) useStore.setState({ selected: sel });
    errorToast(e);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function setArchiving(key: string, a: Archiving | null) {
  useStore.setState((s) => {
    const archiving = { ...s.archiving };
    if (a) archiving[key] = a;
    else delete archiving[key];
    return { archiving };
  });
}

/** Sessions in the order the sidebar shows them, skipping collapsed blocks. */
export function visibleSessionOrder(): { host: string; id: string }[] {
  const s = useStore.getState();
  const hosts = Object.values(s.hosts).sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id));
  // Only the workspace the sidebar shows (X32), as it shows it: each shared
  // section once, with every member's sessions (X68).
  return sharedSessionOrder({
    shown: shownWorkspace(s),
    hosts: hosts.map((h) => ({ host: h.id, account: s.accounts[h.id]?.account, workspaces: s.workspaces[h.id] ?? [], sections: s.sections[h.id] ?? [] })),
    projects: s.projects,
    sessions: s.sessions,
    activeAt: (host, x) => lastActive(s.terminals[host] ?? {}, x),
    stateOf: (host, x) => sessionState(s, host, x.id),
    collapsed: s.collapsed,
  });
}

export function selectSessionByIndex(i: number) {
  const t = visibleSessionOrder()[i];
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

/** Copies the selected block's output, else the newest one (⇧⌘C, T8). */
export function copyOutput() {
  const e = focusedEntry();
  if (!e) return;
  const { text, toast: message } = outputToCopy(e.copySelected("output"), e.lastOutput());
  if (text) void navigator.clipboard.writeText(text).then(() => toast(message ?? "Copied output"), errorToast);
  else if (message) toast(message);
}

/** New design… (⇧⌘N in Design mode): New design for the shown workspace,
 *  in Design mode, where the design it makes shows (X65). */
function newDesign() {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  const host = designHostOf(s);
  if (!ws || !host) return;
  setMode("design");
  // On the host Design mode reads, so the new design shows there (X71).
  openNewDesign({ ...ws, host });
}

/** Handlers of the Run action modal's actions, by id (X19). */
const RUN: Record<string, () => void> = {
  "new-session": () => useStore.setState({ dialog: { kind: "new-session" } }),
  "new-design": newDesign,
  "new-ws": () => useStore.setState({ dialog: { kind: "new-workspace" } }),
  "new-section": () => useStore.setState({ dialog: { kind: "new-section" } }),
  "add-project": () => useStore.setState({ dialog: { kind: "add-project" } }),
  "new-tab": () => void newSessionAgentTab(),
  "new-terminal": () => void newTab(),
  "split-r": () => void split("row"),
  "split-d": () => void split("col"),
  close: () => void closeFocused(),
  run: () => void runScript("run"),
  setup: () => void runScript("setup"),
  "project-settings": () => openProjectSettings(),
  changes: () => useStore.setState({ rightTab: "changes", rightOpen: true }),
  files: () => useStore.setState({ rightTab: "files", rightOpen: true }),
  checks: () => useStore.setState({ rightTab: "review", rightOpen: true }),
  commit: () => useStore.setState({ dialog: { kind: "commit" } }),
  pr: () => useStore.setState({ dialog: { kind: "create-pr" } }),
  archive: () => void archiveSession(),
  find: () => window.dispatchEvent(new CustomEvent("moonlet:find")),
  "prev-cmd": () => focusedEntry()?.jumpBlock(-1),
  "next-cmd": () => focusedEntry()?.jumpBlock(1),
  "copy-out": copyOutput,
  rerun: () => focusedEntry()?.rerunLast(),
  history: () => useStore.setState({ showHistory: true }),
  tasks: () => toggleMode("tasks"),
  design: () => toggleMode("design"),
  settings: () => void goSettings({ page: "general" }),
  "check-updates": () => void checkForUpdates({ manual: true }),
};

export function runAction(id: string) {
  RUN[id]?.();
}

/** Opens the Agents tab on its list, or on one agent (`agentKey`) (X42). */
export const openAgents = (agentDetail: string | null = null) => useStore.setState({ rightOpen: true, rightTab: "agents", agentDetail });

/** Opens the Jobs tab on its list, or on one job (X62). */
export const openJobs = (jobDetail: string | null = null) => useStore.setState({ rightOpen: true, rightTab: "jobs", jobDetail });

/** Opens a job's output as a tab of the session (X62). */
export function openJobTab(host: string, wsId: string, job: string) {
  setLayout(host, wsId, openJob(getLayout(host, wsId), job));
}

export function closeJobTab(host: string, wsId: string, job: string) {
  setLayout(host, wsId, closeJob(getLayout(host, wsId), job));
}

/** Stops a job (X62); its changes so far still come back. */
export const stopJob = (host: string, job: string) => void rpc(host, M.jobStop, { job }).catch(errorToast);

/** Copies a job's stored output (X62). */
export function copyJobOutput(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast("Copied output"), errorToast);
}

/** Opens the Changes tab, to review what the agents changed (X42). */
export const openChanges = () => useStore.setState({ rightOpen: true, rightTab: "changes" });
