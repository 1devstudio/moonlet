// Typing into a session another member runs brings it to this Mac (X73),
// and Move to… moves one. The daemons move them; this asks and follows.

import { create } from "zustand";
import { DaemonError, rpc } from "./daemon";
import { bringsHere, waitingLine } from "./follow";
import { M } from "./protocol";
import { errorToast, selectSession, toast, useStore } from "./store";
import { useSync } from "./syncStore";

/** How long a typed message waits for the turn there to end. */
const WAIT_MS = 10 * 60_000;

/** Sends `text` into session `sessionId` listed from `host`: brought here
 * first when it runs on another member of this Mac's account, else sent
 * as `send` does. While a turn runs there, it waits, with Move now. */
export async function sendOrBring(host: string, sessionId: string, text: string, send: () => Promise<unknown>) {
  const st = useStore.getState();
  const s = (st.sessions[host] ?? []).find((x) => x.id === sessionId);
  if (!s || !bringsHere(host, st.accounts, s)) return send();
  const owner = st.hosts[host]?.label ?? host;
  const bring = async (now: boolean) => {
    await rpc("local", M.sessionBring, { session: sessionId, now, message: text });
    selectSession("local", sessionId);
  };
  try {
    await bring(false);
  } catch (e) {
    if (!(e instanceof DaemonError) || e.code !== "busy") return errorToast(e);
    let done = false;
    toast(waitingLine(owner), "info", {
      label: "Move now",
      run: () => {
        done = true;
        void bring(true).catch(errorToast);
      },
    });
    const until = Date.now() + WAIT_MS;
    while (!done && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      if (done) return;
      try {
        await bring(false);
        return;
      } catch (e) {
        if (!(e instanceof DaemonError) || e.code !== "busy") return errorToast(e);
      }
    }
  }
}

/** Move to… `to` (a worker id), and keep the session there. */
export async function moveSession(host: string, sessionId: string, to: string, now: boolean) {
  try {
    await rpc("local", M.sessionMove, { session: sessionId, to, now });
    if (host !== "local") selectSession("local", sessionId);
  } catch (e) {
    if (e instanceof DaemonError && e.code === "busy") {
      toast("It moves when the turn ends.", "info", { label: "Move now", run: () => void moveSession(host, sessionId, to, true) });
      return;
    }
    errorToast(e);
  }
}

/** Whether the central host could continue each of this Mac's sessions
 * (X73), by session id, from its `session.ready`. */
export const useReady = create<{ ready: Record<string, { ready: boolean; reason?: string | null }> }>(() => ({ ready: {} }));

/** Asks the central host every 30 s, for the readiness mark. */
export function startReadiness() {
  const ask = async () => {
    const central = useSync.getState().central;
    if (!central || useStore.getState().hosts[central]?.status !== "connected") return;
    try {
      const list = await rpc<{ session: string; ready: boolean; reason?: string | null }[]>(central, M.sessionReady);
      useReady.setState({ ready: Object.fromEntries(list.map((r) => [r.session, r])) });
    } catch {
      // A central host from before X73 has no answer: no marks.
    }
  };
  void ask();
  return setInterval(() => void ask(), 30_000);
}
