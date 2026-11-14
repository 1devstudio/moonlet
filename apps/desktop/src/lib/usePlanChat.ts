// The chat of a session the Plan tab follows (X24), for the right panel
// and for a chat's plan card, which offers Open plan unless the tab shows
// its plan.

import { chatSummary, useChat } from "./chat";
import { planChat } from "./plan";
import { sesKey, useStore } from "./store";

/** The chat whose plan the Plan tab shows among session `sessionId`'s
 *  chats (`planChat`); null without one. */
export function usePlanChat(host: string, sessionId: string | null): number | null {
  // A string, so the selector result compares by value.
  const ids = useStore((s) =>
    sessionId === null
      ? ""
      : Object.values(s.terminals[host] ?? {})
          .filter((t) => t.session_id === sessionId && t.chat && !t.exit)
          .map((t) => t.id)
          .join(","),
  );
  const focused = useStore((s) => (sessionId === null ? null : (s.layouts[sesKey(host, sessionId)]?.focused ?? null)));
  return useChat((s) =>
    planChat(
      focused,
      ids ? ids.split(",").map((id) => ({ id: Number(id), st: chatSummary(s, host, Number(id)) })) : [],
    ),
  );
}
