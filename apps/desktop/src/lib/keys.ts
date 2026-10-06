// App shortcuts. All use ⌘ so they never collide with keys an agent's TUI
// needs; the terminal is told to ignore every ⌘ combination (T2).

import { draftToAgent, focusPane, focusedEntry, runAction, selectSessionByIndex, switchTab } from "./actions";
import { actionForKey, keyId } from "./runActions";
import { errorToast, toast, useStore } from "./store";
import { pickBlockForAgent } from "./terminals";

type Handler = () => void;

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

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    // Dialogs handle their own keys, except the palette toggle.
    const dialog = useStore.getState().dialog;
    const id = keyId(e);
    if (dialog && id !== "cmd+k") return;
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
    if (/^cmd\+[1-9]$/.test(id)) {
      e.preventDefault();
      selectSessionByIndex(Number(id.slice(-1)) - 1);
      return;
    }
    // Inside Monaco or text fields, leave editing shortcuts alone.
    const t = e.target as HTMLElement | null;
    const editable = t?.closest(".monaco-editor") || (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.closest(".xterm"));
    if (editable && ["cmd+f", "cmd+d", "cmd+arrowup", "cmd+arrowdown", "shift+cmd+c"].includes(id)) return;
    const action = actionForKey(id, useStore.getState().settings.shortcuts);
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
