// Moving around the settings page (X43). A workspace or project page with
// unsaved edits sets a leave guard, so going elsewhere asks first (X8's
// discard confirm), from the nav, the close button, Esc or an entry point.

import { askConfirm } from "./confirm";
import { routeFocus, routeKey, type SettingsRoute } from "./settingsPage";
import { useStore } from "./store";

/** What leaving the current page does: go, ask with `message`, or wait for
 * a save that is running. */
export type LeaveGuard = () => { state: "close" | "ask" | "wait"; message: string };

let guard: LeaveGuard | null = null;

export function setLeaveGuard(g: LeaveGuard | null) {
  guard = g;
}

/** Opens `next` (null closes the page) once unsaved edits are dealt with. */
export async function goSettings(next: SettingsRoute | null): Promise<void> {
  // The page already open: nothing is left, so nothing to ask.
  const open = useStore.getState().settingsPage;
  if (next && open && routeKey(next) === routeKey(open) && !routeFocus(next)) return;
  const g = guard?.();
  if (g?.state === "wait") return;
  if (g?.state === "ask") {
    const discard = await askConfirm({ title: "Discard changes", message: g.message, action: "Discard", cancel: "Keep editing", variant: "danger" });
    if (!discard) return;
  }
  useStore.setState({ settingsPage: next });
}
