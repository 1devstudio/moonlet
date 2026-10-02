// App shortcuts. All use ⌘ so they never collide with keys an agent's TUI
// needs; the terminal is told to ignore every ⌘ combination (T2).

import { closeFocused, focusPane, focusedEntry, newTab, runScript, selectWorkspaceByIndex, split, switchTab } from "./actions";
import { useStore } from "./store";

type Handler = () => void;

/** Key: modifiers in fixed order + lower-case key, e.g. "shift+cmd+n". */
const bindings: Record<string, Handler> = {
  "shift+cmd+n": () => useStore.setState({ dialog: { kind: "new-workspace" } }),
  "cmd+k": () => useStore.setState({ dialog: { kind: "palette" } }),
  "shift+cmd+p": () => useStore.setState({ dialog: { kind: "create-pr" } }),
  "cmd+,": () => useStore.setState({ dialog: { kind: "settings" } }),
  "cmd+t": () => void newTab(),
  "cmd+d": () => void split("row"),
  "alt+cmd+d": () => void split("col"),
  "cmd+w": () => void closeFocused(),
  "cmd+r": () => void runScript("run"),
  "cmd+b": () => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })),
  "cmd+\\": () => useStore.setState((s) => ({ rightOpen: !s.rightOpen })),
  "shift+cmd+d": () => useStore.setState({ rightTab: "changes", rightOpen: true }),
  "shift+cmd+e": () => useStore.setState({ rightTab: "files", rightOpen: true }),
  "cmd+f": () => window.dispatchEvent(new CustomEvent("jaunt:find")),
  "alt+cmd+arrowright": () => focusPane(1),
  "alt+cmd+arrowleft": () => focusPane(-1),
  "shift+cmd+]": () => switchTab(1),
  "shift+cmd+[": () => switchTab(-1),
  "cmd+arrowup": () => focusedEntry()?.jumpBlock(-1),
  "cmd+arrowdown": () => focusedEntry()?.jumpBlock(1),
  "shift+cmd+c": () => {
    const out = focusedEntry()?.lastOutput();
    if (out) void navigator.clipboard.writeText(out);
  },
};

export function keyId(e: KeyboardEvent): string {
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("cmd");
  // With ⌥ held, e.key is a composed character; use the physical key.
  let key = e.key.toLowerCase();
  if (e.altKey && e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
  if (e.code === "BracketRight") key = "]";
  if (e.code === "BracketLeft") key = "[";
  parts.push(key);
  return parts.join("+");
}

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    // Dialogs handle their own keys, except the palette toggle.
    const dialog = useStore.getState().dialog;
    const id = keyId(e);
    if (dialog && id !== "cmd+k") return;
    if (/^cmd\+[1-9]$/.test(id)) {
      e.preventDefault();
      selectWorkspaceByIndex(Number(id.slice(-1)) - 1);
      return;
    }
    // Inside Monaco or text fields, leave editing shortcuts alone.
    const t = e.target as HTMLElement | null;
    const editable = t?.closest(".monaco-editor") || (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.closest(".xterm"));
    if (editable && ["cmd+f", "cmd+d", "cmd+arrowup", "cmd+arrowdown", "shift+cmd+c"].includes(id)) return;
    const h = bindings[id];
    if (h) {
      e.preventDefault();
      e.stopPropagation();
      h();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
