// Typing into a session another member runs brings it to this Mac (X73),
// and Run only on… moves one. The daemons move them; this asks and follows.

import { create } from "zustand";
import { rpc } from "./daemon";
import { bringsHere, joinWaiting, movedHost, readinessOf, untilTurnEnds, waitingLine, type ReadyRow, type WaitingMessage } from "./follow";
import type { ChatImage } from "./attachments";
import { M } from "./protocol";
import { dismissToast, errorToast, selectSession, toast, useStore } from "./store";
import { useSync } from "./syncStore";

/** How long Run only on… waits for the turn there to end. */
const WAIT_MS = 10 * 60_000;

/** How long a typed message waits for the turn there to end: until it
 * does, however long (X73). The session then moves here with it. */
const TYPED_WAIT_MS = Number.POSITIVE_INFINITY;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The message waiting for each session to move here, by session id. */
const waiting = new Map<string, WaitingMessage>();

/** Sends `text` and `images`, typed into chat `terminal` of session
 * `sessionId` listed from `host`: brought here first when it runs on
 * another member of this Mac's account, with the message going to that
 * chat once here; else sent as `send` does. While a turn runs there, it
 * waits until the turn ends, however long, with Move now; more typed into
 * that chat meanwhile goes with it. When it cannot be brought, the message
 * goes where the session runs, by `send`. */
export async function sendOrBring(
  host: string,
  sessionId: string | undefined,
  terminal: number,
  text: string,
  images: ChatImage[],
  send: (text: string, images: ChatImage[]) => Promise<unknown>,
) {
  const st = useStore.getState();
  const s = sessionId ? (st.sessions[host] ?? []).find((x) => x.id === sessionId) : undefined;
  if (!sessionId || !s || !bringsHere(host, st.accounts, s)) return send(text, images);
  const pending = waiting.get(sessionId);
  if (pending) {
    const joined = joinWaiting(pending, { terminal, text, images });
    // Another chat's message is not held behind this one: it goes there.
    if (!joined) return send(text, images);
    waiting.set(sessionId, joined);
    return;
  }
  waiting.set(sessionId, { terminal, text, images });
  const owner = st.hosts[host]?.label ?? host;
  // The waiting line, with Move now, stays for as long as the wait.
  let line: number | null = null;
  try {
    await untilTurnEnds({
      attempt: async (now) => {
        const m = waiting.get(sessionId)!;
        await rpc("local", M.sessionBring, { session: sessionId, now, terminal: m.terminal, message: m.text, images: m.images });
      },
      waiting: (moveNow) => {
        line = toast(waitingLine(owner), "info", { label: "Move now", run: moveNow }, { sticky: true });
      },
      sleep,
      clock: Date.now,
      waitMs: TYPED_WAIT_MS,
      everyMs: 3000,
    });
    waiting.delete(sessionId);
    selectSession("local", sessionId);
  } catch (e) {
    // Not brought: the message is not lost, it goes where the session runs.
    const m = waiting.get(sessionId)!;
    waiting.delete(sessionId);
    errorToast(e);
    return send(m.text, m.images);
  } finally {
    if (line !== null) dismissToast(line);
  }
}

/** Run only on… `to` (a worker id), and keep the session there. While a turn
 * runs, it moves when the turn ends, with Move now; then the session is
 * shown where it is listed now. */
export async function moveSession(sessionId: string, to: string) {
  try {
    const got = await untilTurnEnds({
      attempt: async (now) => {
        await rpc("local", M.sessionMove, { session: sessionId, to, now });
      },
      waiting: (moveNow) => toast("It moves when the turn ends.", "info", { label: "Move now", run: moveNow }),
      sleep,
      clock: Date.now,
      waitMs: WAIT_MS,
      everyMs: 3000,
    });
    if (got === "timeout") return toast("Not moved: the turn still runs after ten minutes.", "error");
    const sync = useSync.getState();
    const shown = movedHost({ to, me: sync.me, centralHost: sync.central });
    if (shown) selectSession(shown, sessionId);
  } catch (e) {
    errorToast(e);
  }
}

/** Whether the central host could continue each of this Mac's sessions
 * (X73), by session id, from its `session.ready`. */
export const useReady = create<{ ready: Record<string, ReadyRow> }>(() => ({ ready: {} }));

/** Asks the central host every 30 s, for the readiness mark. */
export function startReadiness() {
  const ask = async () => {
    const central = useSync.getState().central;
    const ready = await readinessOf({
      central,
      connected: !!central && useStore.getState().hosts[central]?.status === "connected",
      ask: (c) => rpc<ReadyRow[]>(c, M.sessionReady),
      current: () => useSync.getState().central,
    });
    if (ready) useReady.setState({ ready });
  };
  void ask();
  return setInterval(() => void ask(), 30_000);
}
