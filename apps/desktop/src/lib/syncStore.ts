// Keep in sync (X60): this Mac's live copies, from its own daemon, which
// follows `sync.changed`. Sessions live on the central host; their copies,
// and every `sync.*` call, on this Mac.

import { create } from "zustand";
import { DaemonError, hostsApi, onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { askConfirm } from "./confirm";
import { EV, M, type Copy, type CopyChanged, type DaemonInfo, type LinkInfo, type LinkState, type ProjectIdentity } from "./protocol";
import { centralPrompt, differsNotice, endedToast, setupActions, setupPrompt, stopPrompt, syncChoice } from "./sync";
import { errorToast, notify, selectSession, sesKey, toast, useStore } from "./store";
import { differsAlert } from "./alerts";
import { readStored, writeStored } from "./storage";

const LOCAL = "local";
const NOTE_KEY = "syncNoteSeen";

interface SyncState {
  /** Copies by the session they keep (`sesKey(host, session)`). */
  copies: Record<string, Copy>;
  /** This Mac's central host, by name (its host id), from `link.get`. */
  central: string | null;
  /** The link's state, so a copy can say the central host refused this Mac (X41). */
  link: LinkState | null;
  /** This Mac's daemon's data folder, for where leftovers go. */
  dataDir: string | null;
  /** The session (`sesKey`) whose sync popover is open. */
  popover: string | null;
  /** The first-use note was read (X60 Security considerations). */
  noteSeen: boolean;
}

export const useSync = create<SyncState>(() => ({
  copies: {},
  central: null,
  link: null,
  dataDir: null,
  popover: null,
  noteSeen: readStored(NOTE_KEY) === "1",
}));

const setSync = useSync.setState;
const getSync = useSync.getState;

export const copyKey = (c: Copy) => sesKey(c.host, c.session);

const sessionOf = (c: Copy) => useStore.getState().sessions[c.host]?.find((s) => s.id === c.session);
const home = () => useStore.getState().hosts[LOCAL]?.home ?? null;
const sessionName = (c: Copy, fallback: string) => sessionOf(c)?.name ?? fallback;

/** This Mac's moonlet folder: where leftovers and setup output go. */
export function syncDataDir(): string {
  const h = home();
  return getSync().dataDir ?? (h ? `${h}/.moonlet` : "~/.moonlet");
}

const fromLink = (link: LinkInfo) => ({ central: link.central?.name ?? null, link: link.state });

/** Setups asked about in this run, by copy and command, so one event does not ask twice. */
const asked = new Set<string>();
/** The last differing-files notification, for the jump back when the user comes to the window. */
let lastNotice: { key: string; at: number } | null = null;

async function load() {
  try {
    const [copies, link, info] = await Promise.all([
      rpc<Copy[]>(LOCAL, M.syncList),
      rpc<LinkInfo>(LOCAL, M.linkGet),
      rpc<DaemonInfo>(LOCAL, M.daemonInfo).catch(() => null),
    ]);
    setSync({ copies: Object.fromEntries(copies.map((c) => [copyKey(c), c])), ...fromLink(link), dataDir: info?.data_dir ?? null });
    for (const c of copies) maybeAskSetup(c);
  } catch {
    /* an older daemon without sync */
  }
}

function onChanged(ev: CopyChanged) {
  const { newly_differing, removed, ...copy } = ev;
  const key = copyKey(copy);
  if (removed) {
    setSync((s) => {
      const copies = { ...s.copies };
      delete copies[key];
      return { copies, popover: s.popover === key ? null : s.popover };
    });
    toast(endedToast(sessionName(copy, "The session"), copy.host, removed, home()));
    return;
  }
  setSync((s) => ({ copies: { ...s.copies, [key]: copy } }));
  maybeAskSetup(copy);
  if (newly_differing?.length) void noticeDiffers(copy, newly_differing);
}

async function noticeDiffers(copy: Copy, paths: string[]) {
  const st = useStore.getState();
  const n = differsNotice(sessionName(copy, "A session"), copy.host, paths);
  const alert = differsAlert({ focused: document.hasFocus(), notifyWhenFocused: st.settings.notifyWhenFocused, banner: st.settings.syncBanner !== false });
  if (alert.toast) toast(n.text, "info", { label: "Pick a version", run: () => openSyncPopover(copy.host, copy.session) });
  if (alert.banner) {
    lastNotice = { key: copyKey(copy), at: Date.now() };
    await notify(n.title, n.body);
  }
}

/** Opens the session and its sync popover. */
export function openSyncPopover(host: string, session: string) {
  selectSession(host, session);
  setSync({ popover: sesKey(host, session) });
}

function maybeAskSetup(copy: Copy) {
  const s = copy.setup;
  if (s?.state.kind !== "needs_approval") return;
  const key = `${copy.id}\n${s.command}`;
  if (asked.has(key)) return;
  asked.add(key);
  void askSetup(copy, s.command);
}

/** The setup modal: Run setup approves this exact command; Skip leaves it unrun. */
export async function askSetup(copy: Copy, command: string): Promise<void> {
  const project = useStore.getState().projects[copy.host]?.find((p) => p.id === sessionOf(copy)?.project_id)?.name ?? "the project";
  const ok = await askConfirm(setupPrompt(project, command));
  if (!ok) {
    await rpc(LOCAL, M.syncSkipSetup, { copy: copy.id }).catch(errorToast);
    return;
  }
  await runSetup(copy, command);
}

/** Runs `command`, asking again when the copy's setup changed meanwhile. */
export async function runSetup(copy: Copy, command: string): Promise<void> {
  try {
    await rpc(LOCAL, M.syncRunSetup, { copy: copy.id, command });
  } catch (e) {
    if (e instanceof DaemonError && e.code === "setup_changed") {
      asked.add(`${copy.id}\n${e.message}`);
      await askSetup(copy, e.message);
    } else if (e instanceof DaemonError && e.code === "no_setup") toast(`${sessionName(copy, "The session")} has no setup script any more.`);
    else errorToast(e);
  }
}

/** The popover's Run setup (again): asks first unless this exact command was approved. */
export async function runSetupAgain(copy: Copy): Promise<void> {
  const s = copy.setup;
  const run = s && setupActions(s).run;
  if (!s || !run) return;
  await (run.asks ? askSetup(copy, s.command) : runSetup(copy, s.command));
}

/** Keep in sync with this Mac, from a session's right-click menu or the composer. */
export async function keepInSync(host: string, session: string): Promise<void> {
  const st = useStore.getState();
  const choice = syncChoice(host, st.hosts[host]?.kind, getSync().central);
  if (!choice) return;
  if (choice.needsCentral) {
    const name = st.sessions[host]?.find((s) => s.id === session)?.name ?? "this session";
    if (!(await askConfirm(centralPrompt(name, host)))) return;
    try {
      setSync(fromLink(await hostsApi.setCentral(host)));
    } catch (e) {
      errorToast(e);
      return;
    }
  }
  try {
    const copy = await rpc<Copy>(LOCAL, M.syncStart, { session });
    setSync((s) => ({ copies: { ...s.copies, [copyKey(copy)]: copy } }));
  } catch (e) {
    errorToast(e);
  }
}

/** Stop keeping in sync, after the modal says what is removed and saved.
 * The toast comes with the `sync.changed` that says the copy went; a copy
 * kept because its files could not be saved or it could not be removed
 * says why. */
export async function stopSync(copy: Copy): Promise<void> {
  const name = sessionName(copy, "this session");
  if (!(await askConfirm(stopPrompt(name, copy.differs.length, syncDataDir(), home())))) return;
  try {
    await rpc(LOCAL, M.syncStop, { copy: copy.id });
  } catch (e) {
    if (e instanceof DaemonError && (e.code === "not_saved" || e.code === "failed")) toast(`${name} is still kept in sync: ${e.message}`, "error");
    else errorToast(e);
  }
}

/** The composer's checkbox left unticked: this session gets no copy, even
 * when its project keeps new sessions in sync (X60). */
export const declineSync = (session: string) => rpc(LOCAL, M.syncDecline, { session }).catch(errorToast);

export const resolveSync = (copy: Copy, path: string, keep: "central" | "worker") => rpc(LOCAL, M.syncResolve, { copy: copy.id, path, keep }).catch(errorToast);
export const useCentralBranch = (copy: Copy) => rpc(LOCAL, M.syncUseCentralBranch, { copy: copy.id }).catch(errorToast);
export const retrySync = (copy: Copy) => rpc(LOCAL, M.syncRetry, { copy: copy.id }).catch(errorToast);

/** The project page's switch and the composer's default (X60). */
export async function projectKeepsNew(identity: ProjectIdentity | undefined): Promise<boolean> {
  if (!identity?.root) return false;
  return rpc<{ keep_new: boolean }>(LOCAL, M.syncProjectGet, { identity })
    .then((r) => r.keep_new)
    .catch(() => false);
}

export const setProjectKeepsNew = (identity: ProjectIdentity, keep_new: boolean) => rpc<{ keep_new: boolean }>(LOCAL, M.syncProjectSet, { identity, keep_new });

export function dismissSyncNote() {
  writeStored(NOTE_KEY, "1");
  setSync({ noteSeen: true });
}

let started = false;

export async function startSync() {
  if (started) return;
  started = true;
  await onDaemonEvent((e) => {
    if (e.host !== LOCAL) return;
    if (e.name === EV.syncChanged) onChanged(e.data as CopyChanged);
    else if (e.name === EV.linkChanged) setSync(fromLink(e.data as LinkInfo));
  });
  await onHostStatus((h) => {
    if (h.id === LOCAL && h.status === "connected") void load();
  });
  await load();
  // Tauri cannot tell a notification click from coming back to the window
  // (A3): coming back soon after one offers the files instead.
  window.addEventListener("focus", () => {
    const n = lastNotice;
    if (!n || Date.now() - n.at > 120_000) return;
    lastNotice = null;
    const c = getSync().copies[n.key];
    if (c?.differs.length) toast(differsNotice(sessionName(c, "A session"), c.host, c.differs).text, "info", { label: "Pick a version", run: () => openSyncPopover(c.host, c.session) });
  });
}
