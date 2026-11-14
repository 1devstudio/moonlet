// Typing into a session another member runs brings it to this Mac (X73),
// as Bring to this Mac in its menu does, and Run only on… moves one. The
// daemons move them; this asks and follows.

import { create } from "zustand";
import { rpc } from "./daemon";
import { bringsHere, cannotComeLine, joinWaiting, keptOnLine, movedHost, readinessOf, untilTurnEnds, waitingLine, type ReadyRow, type WaitingMessage } from "./follow";
import type { ChatImage } from "./attachments";
import { M, type Session } from "./protocol";
import { dismissToast, errorMessage, errorToast, selectSession, toast, useStore } from "./store";
import { useSync } from "./syncStore";

/** How long Run only on… waits for the turn there to end. */
const WAIT_MS = 10 * 60_000;

/** How long a typed message waits for the turn there to end: until it
 * does, however long (X73). The session then moves here with it. */
const TYPED_WAIT_MS = Number.POSITIVE_INFINITY;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Send = (text: string, images: ChatImage[]) => Promise<unknown>;

/** A message typed for a session, with how it is sent where the session
 * runs. */
interface Typed {
  message: WaitingMessage;
  send: Send;
}

/** What each session waits to move here with, by session id: a typed
 * message, or nothing when brought from its menu (X73). */
const waiting = new Map<string, Typed | null>();

/** The message of each session that could not come here, held in toast
 * `toast` until the user sends it there, tries again, or closes it. */
const held = new Map<string, Typed & { toast: number }>();

/** Sends `text` and `images`, typed into chat `terminal` of session
 * `sessionId` listed from `host`: brought here first when it runs on
 * another member of this Mac's account, with the message going to that
 * chat once here; else sent as `send` does. While a turn runs there, it
 * waits until the turn ends, however long, with Move now; more typed into
 * that chat meanwhile goes with it. When it cannot be brought, a toast says
 * why and holds the message, with what is typed into that chat meanwhile:
 * Send it there sends it by `send`, Try again brings it again. */
export async function sendOrBring(host: string, sessionId: string | undefined, terminal: number, text: string, images: ChatImage[], send: Send) {
  const st = useStore.getState();
  const s = sessionId ? (st.sessions[host] ?? []).find((x) => x.id === sessionId) : undefined;
  if (!sessionId || !s || !bringsHere(host, st.accounts, s)) return send(text, images);
  const message = { terminal, text, images };
  // Brought from its menu meanwhile: the message goes with it.
  if (waiting.get(sessionId) === null) {
    waiting.set(sessionId, { message, send });
    return;
  }
  for (const queue of [held, waiting]) {
    const pending = queue.get(sessionId);
    if (!pending) continue;
    const joined = joinWaiting(pending.message, message);
    // Another chat's message is not held behind this one: it goes there.
    if (!joined) return send(text, images);
    pending.message = joined;
    return;
  }
  waiting.set(sessionId, { message, send });
  return bring(host, s);
}

/** Bring to this Mac, from session `sessionId`'s menu (X73): brought here
 * as typing brings it, with no message, or with the message held in its
 * toast; a message typed meanwhile goes with it. When it cannot come, a
 * toast says why, with Try again. On its way already, nothing more. */
export async function bringHere(host: string, sessionId: string) {
  const st = useStore.getState();
  const s = (st.sessions[host] ?? []).find((x) => x.id === sessionId);
  if (!s || waiting.has(sessionId)) return;
  const kept = held.get(sessionId);
  held.delete(sessionId);
  // Its toast's message goes with it, so nothing is left to send there.
  if (kept) dismissToast(kept.toast);
  waiting.set(sessionId, kept ? { message: kept.message, send: kept.send } : null);
  return bring(host, s);
}

/** Brings session `s`, listed from `host`, here with what it waits with. */
async function bring(host: string, s: Session) {
  const owner = useStore.getState().hosts[host]?.label ?? host;
  // The waiting line, with Move now, stays for as long as the wait.
  let line: number | null = null;
  let keptOn: string | undefined;
  try {
    await untilTurnEnds({
      attempt: async (now) => {
        const m = waiting.get(s.id)?.message;
        const message = m ? { terminal: m.terminal, message: m.text, images: m.images } : { images: [] };
        const brought = await rpc<{ kept_on?: string }>("local", M.sessionBring, { session: s.id, now, ...message });
        keptOn = brought?.kept_on;
      },
      waiting: (moveNow) => {
        line = toast(waitingLine(owner), "info", { label: "Move now", run: moveNow }, { sticky: true });
      },
      sleep,
      clock: Date.now,
      waitMs: TYPED_WAIT_MS,
      everyMs: 3000,
    });
    waiting.delete(s.id);
    selectSession("local", s.id);
    if (keptOn) toast(keptOnLine(s.name, keptOn, s.branch), "info", undefined, { sticky: true });
  } catch (e) {
    const typed = waiting.get(s.id) ?? null;
    waiting.delete(s.id);
    const pinned = e instanceof Object && "code" in e && e.code === "pinned";
    if (!typed) {
      // Kept there: trying again would not bring it.
      if (pinned) toast(cannotComeLine(s.name, errorMessage(e)), "error");
      else toast(cannotComeLine(s.name, errorMessage(e)), "error", { label: "Try again", run: () => void bringHere(host, s.id) }, { sticky: true });
      return;
    }
    // Kept there since the app last heard: it goes to the owner, as any
    // message for a session kept elsewhere does.
    if (pinned) return typed.send(typed.message.text, typed.message.images);
    hold(host, s, typed, errorMessage(e));
  } finally {
    if (line !== null) dismissToast(line);
  }
}

/** Holds message `typed` of session `s` in a toast saying `why` it can't
 * come here, until the user sends it there, tries again, or closes it. */
function hold(host: string, s: Session, typed: Typed, why: string) {
  const take = (): Typed => {
    const now = held.get(s.id) ?? typed;
    held.delete(s.id);
    return { message: now.message, send: now.send };
  };
  const id = toast(
    cannotComeLine(s.name, why),
    "error",
    {
      label: "Send it there",
      run: () => {
        const now = take();
        // Not sent: held again, so it is not lost.
        void now.send(now.message.text, now.message.images).catch((e) => {
          errorToast(e);
          hold(host, s, now, why);
        });
      },
    },
    {
      sticky: true,
      secondAction: {
        label: "Try again",
        run: () => {
          waiting.set(s.id, take());
          void bring(host, s);
        },
      },
      onClose: () => void held.delete(s.id),
    },
  );
  held.set(s.id, { ...typed, toast: id });
}

/** Run only on… `to` (a worker id), and keep the session there. While a turn
 * runs, it moves when the turn ends, with Move now; then the session is
 * shown where it is listed now. */
export async function moveSession(sessionId: string, to: string) {
  // As listed before it moves, for the branch its commits may go on.
  const s = Object.values(useStore.getState().sessions)
    .flat()
    .find((x) => x.id === sessionId);
  let keptOn: string | undefined;
  try {
    const got = await untilTurnEnds({
      attempt: async (now) => {
        const moved = await rpc<{ kept_on?: string }>("local", M.sessionMove, { session: sessionId, to, now });
        keptOn = moved?.kept_on;
      },
      waiting: (moveNow) => toast("It moves when the turn ends.", "info", { label: "Move now", run: moveNow }),
      sleep,
      clock: Date.now,
      waitMs: WAIT_MS,
      everyMs: 3000,
    });
    if (got === "timeout") return toast("Not moved: the turn still runs after ten minutes.", "error");
    if (keptOn && s) toast(keptOnLine(s.name, keptOn, s.branch), "info", undefined, { sticky: true });
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
