// The colours the phone app gives states (X40), from the design tokens in
// the desktop's moonlet.css, in one place.

import type { AgentState } from "@desktop/lib/protocol";
import type { CheckMark } from "./checks";
import type { HostWord } from "./hosts";

export const STATE_COLOR: Record<AgentState, string> = {
  blocked: "var(--color-blocked)",
  working: "var(--color-working)",
  done: "var(--color-done)",
  error: "var(--color-error)",
  idle: "var(--color-muted)",
};

export const HOST_COLOR: Record<HostWord, string> = {
  connected: STATE_COLOR.done,
  connecting: STATE_COLOR.blocked,
  offline: "var(--color-faint)",
};

export const CHECK_COLOR: Record<CheckMark, string> = {
  ok: STATE_COLOR.done,
  running: STATE_COLOR.blocked,
  error: STATE_COLOR.error,
};

/** A diff line's background and text, by its sign. */
export const DIFF_LINE = {
  add: "bg-[#14301d] text-[#9fe0b0]",
  del: "bg-[#3a1719] text-[#f2a7a7]",
};
