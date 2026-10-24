// The sidebar's mode, per workspace: Sessions, Tasks (X45) or Design (X65).

import { type AppMode, shownWorkspace, useStore } from "./store";
import { wsKey } from "./workspaces";

export type { AppMode };

/** The shown workspace's mode. */
export function modeOf(s: ReturnType<typeof useStore.getState>): AppMode {
  const ws = shownWorkspace(s);
  return (ws && s.mode[wsKey(ws.host, ws.id)]) || "sessions";
}

/** Shows `mode` in the shown workspace. */
export function setMode(mode: AppMode) {
  const s = useStore.getState();
  const ws = shownWorkspace(s);
  if (!ws || modeOf(s) === mode) return;
  useStore.setState({ mode: { ...s.mode, [wsKey(ws.host, ws.id)]: mode }, showHistory: false });
}

/** A mode's shortcut (⌃⌘T, ⌃⌘D): opens it, or goes back to Sessions from it. */
export function toggleMode(mode: AppMode) {
  setMode(modeOf(useStore.getState()) === mode ? "sessions" : mode);
}
