// The chat's agents strip (X40, X42): which chats' strips × hid, kept for
// as long as the app runs, as the desktop keeps them in its store.

import { create } from "zustand";
import type { ChatState } from "@desktop/lib/protocol";
import { stripDismissAt } from "@desktop/lib/subagents";
import type { Screen } from "./app";

const useDismissed = create<Record<string, number>>(() => ({}));

/** Hides the strip of the chat `key` until an agent starts after its last one. */
export function dismissStrip(key: string, st: ChatState) {
  useDismissed.setState({ [key]: stripDismissAt(st) });
}

/** Where × hid the chat's strip, for `stripView`; 0 when it never did. */
export const stripDismissedAt = (key: string) => useDismissed.getState()[key] ?? 0;

/** The same, re-rendering when it changes. */
export const useStripDismissedAt = (key: string) => useDismissed((s) => s[key] ?? 0);

/** Where the strip's Review changes goes from the chat opened on `from`: the
 * session's Changes tab. An agent without a session has none to review. */
export function reviewScreen(from: Screen): Screen | null {
  return from.kind === "session" ? { ...from, tab: "changes" } : null;
}
