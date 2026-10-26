// App shortcuts. All use ⌘ so they never collide with keys an agent's TUI
// needs; the terminal is told to ignore every ⌘ combination (T2).

import { draftToAgent, focusPane, focusedEntry, runAction, selectSessionByIndex, switchTab } from "./actions";
import { actionForKey, keyId } from "./runActions";
import { errorToast, switchWorkspaceByIndex, toast, updateSettings, useStore } from "./store";
import { defaultTermSettings, pickBlockForAgent } from "./terminals";
import { stepFontSize } from "./uiScale";
import { modeOf } from "./mode";

type Handler = () => void;

/** ⌘+ and ⌘− change the window's one font size, ⌘0 resets it (X37). */
function updateFontSize(next: (current: number) => number) {
  const { term } = useStore.getState().settings;
  updateSettings({ term: { ...term, fontSize: next(term.fontSize) } });
}
const biggerText = () => updateFontSize((s) => stepFontSize(s, 1));

/** Shortcuts the user cannot change. The Run action modal's actions have
 * their own, user-assignable keys (X19). Key format: see keyId. */
const bindings: Record<string, Handler> = {
  "cmd+k": () => useStore.setState({ dialog: { kind: "palette" } }),
  "cmd+b": () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })),
  "cmd+\\": () => useStore.setState((s) => ({ rightOpen: !s.rightOpen })),
  "alt+cmd+arrowright": () => focusPane(1),
  "alt+cmd+arrowleft": () => focusPane(-1),
  "shift+cmd+]": () => switchTab(1),
  "shift+cmd+[": () => switchTab(-1),
  "cmd+=": biggerText,
  "shift+cmd+=": biggerText,
  "cmd++": biggerText,
  "shift+cmd++": biggerText,
  "cmd+-": () => updateFontSize((s) => stepFontSize(s, -1)),
  "cmd+0": () => updateFontSize(() => defaultTermSettings.fontSize),
  "alt+cmd+c": () => {
    const cmd = focusedEntry()?.copySelected("command");
    if (cmd) void navigator.clipboard.writeText(cmd).then(() => toast("Copied command"), errorToast);
  },
};

/** ⌘↵ on a selected block sends it to the session's agent as a draft;
 * ⇧⌘↵ to a new agent tab (T8). Elsewhere ⌘↵ keeps its own meaning. */
function sendBlock(newTab: boolean): boolean {
  const e = focusedEntry();
  if (!e || !e.el.closest("[data-terminal-pane]")?.contains(document.activeElement)) return false;
  // With nothing selected, the newest block, unless a command is being typed.
  const typed = document.activeElement instanceof HTMLTextAreaElement && !e.el.contains(document.activeElement) ? document.activeElement.value : "";
  const text = e.forAgent(pickBlockForAgent(e.selected, e.blockMode ? e.newestFinished() : null, typed));
  if (!text) return false;
  e.select(null);
  void draftToAgent(text, newTab);
  return true;
}

/** ⌘C on a selected block, while the terminal has focus and no text is
 * selected, copies the block's command and output (T8). Otherwise ⌘C is
 * the usual copy. */
function copyBlock(): boolean {
  const e = focusedEntry();
  if (!e?.selected || e.term.hasSelection() || !e.el.contains(document.activeElement)) return false;
  const text = e.copySelected("all");
  if (text) void navigator.clipboard.writeText(text).then(() => toast("Copied command and output"), errorToast);
  return !!text;
}

/** Screens that take some ⌘ keys from the app while shown, newest first:
 *  the design screen's zoom and chat panel (X65). */
const claims: ((id: string) => boolean)[] = [];

/** Gives `take` the ⌘ keys it says it took (true) before the app's own
 *  shortcuts; the returned function lets go. */
export function claimKeys(take: (id: string) => boolean): () => void {
  claims.unshift(take);
  return () => {
    const at = claims.indexOf(take);
    if (at >= 0) claims.splice(at, 1);
  };
}

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    // Dialogs and the settings page (X43) handle their own keys, except the
    // palette toggle; the confirm modal takes them all (X23).
    const { dialog, confirm, settingsPage } = useStore.getState();
    const id = keyId(e);
    if (confirm || ((dialog || settingsPage) && id !== "cmd+k")) return;
    // A shortcut being recorded (X43) takes every key.
    if (document.querySelector("[data-recording-shortcut]")) return;
    if (id === "cmd+c") {
      if (copyBlock()) e.preventDefault();
      return;
    }
    // Text selected in the terminal wins over the block shortcuts (T8): they
    // neither copy nor swallow the key.
    if ((id === "shift+cmd+c" || id === "alt+cmd+c") && focusedEntry()?.term.hasSelection()) return;
    if (id === "cmd+enter" || id === "shift+cmd+enter") {
      if (sendBlock(id === "shift+cmd+enter")) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (/^ctrl\+cmd\+[1-9]$/.test(id)) {
      e.preventDefault();
      switchWorkspaceByIndex(Number(id.slice(-1)) - 1);
      return;
    }
    if (/^cmd\+[1-9]$/.test(id)) {
      e.preventDefault();
      selectSessionByIndex(Number(id.slice(-1)) - 1);
      return;
    }
    // Inside Monaco or text fields, leave editing shortcuts alone.
    const t = e.target as HTMLElement | null;
    const editable = t?.closest(".monaco-editor") || (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.closest(".xterm"));
    if (editable && ["cmd+f", "cmd+d", "cmd+arrowup", "cmd+arrowdown", "shift+cmd+c"].includes(id)) return;
    if (claims.some((take) => take(id))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = actionForKey(id, useStore.getState().settings.shortcuts, modeOf(useStore.getState()));
    const h = action ? () => runAction(action) : bindings[id];
    if (h) {
      e.preventDefault();
      e.stopPropagation();
      h();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
