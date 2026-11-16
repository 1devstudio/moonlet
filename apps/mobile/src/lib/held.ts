// Messages and answers for a session another member owns, sent through the
// central host (X73). When that member is away for 30 s, the central host
// takes the session over and delivers them there. Before then, or while
// the member's link is silent, it refuses them unsent: the phone holds the
// message or the answer, says when it goes, and sends it again itself,
// once. What nothing will send is shown, never only logged.

import { create } from "zustand";
import { rpc } from "@desktop/lib/daemon";
import { parseCopyHost } from "@desktop/lib/copyHost";
import { continueWait } from "@desktop/lib/centralCopies";
import type { Session } from "@desktop/lib/protocol";
import { useApp } from "./app";
import { useNow } from "./now";

export type What = "message" | "answer";

/** What became of a message or an answer: sent (with what to say when the
 * central host continued the session for it), held to be sent again, or
 * not sent, with why. */
export type Sent =
  | { kind: "sent"; note: string | null }
  | { kind: "held" }
  | { kind: "failed"; line: string };

/** The central host's refusals that leave nothing sent, and that it stops
 * giving once the session can continue or its member answers again. */
const HELD = new Set(["not_yet", "owner_not_responding", "pinned"]);

const codeOf = (e: unknown) =>
  e && typeof e === "object" && "code" in e ? String(e.code) : null;
const messageOf = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String(e.message) : String(e);

/** What became of a call for session `s` through central host `central`,
 * by its answer or its error. */
export function sentOutcome(
  r: { value: unknown } | { error: unknown },
  s: Session,
  central: string,
): Sent {
  const owner = s.owner?.name ?? "Its Mac";
  if ("value" in r) {
    const on =
      r.value && typeof r.value === "object" && "continued_on" in r.value
        ? String(r.value.continued_on)
        : null;
    return {
      kind: "sent",
      note: on ? `${owner} is not reachable. Continuing on ${on}.` : null,
    };
  }
  const code = codeOf(r.error);
  if (code && HELD.has(code)) return { kind: "held" };
  if (code === "owner_offline")
    return {
      kind: "failed",
      line: `Not sent: ${owner} is not reachable. Continue on ${central}, then send it again.`,
    };
  if (code === "owner_lost")
    return {
      kind: "failed",
      line: `${owner} stopped answering before it said whether it got this. Check the chat before you send it again.`,
    };
  if (code === "disconnected" || code === "timeout") {
    return {
      kind: "failed",
      line: `The connection to ${central} dropped before it said whether it got this. Check the chat before you send it again.`,
    };
  }
  if (code === "no_copy")
    return {
      kind: "failed",
      line: `Not sent: ${central} has no copy of ${s.name} yet.`,
    };
  return { kind: "failed", line: `Not sent: ${messageOf(r.error)}` };
}

const away = (s: Session) => !!s.owner && !s.owner.reachable;

/** The line for a message or an answer held for `s` at `now` (ms). */
export function heldLine(
  s: Session,
  central: string,
  what: What,
  now: number,
): string {
  const owner = s.owner?.name ?? "Its Mac";
  if (!s.owner) return `Sending your ${what} to ${central}…`;
  if (away(s) && s.pinned)
    return `Kept on ${owner} · not reachable. Your ${what} goes when ${owner} is back.`;
  if (away(s)) {
    const wait = continueWait(s, now);
    return wait > 0
      ? `${owner} is not reachable. Your ${what} goes on ${central} in ${wait} s.`
      : `${owner} is not reachable. Continuing on ${central}…`;
  }
  return `${owner} is not responding. Your ${what} goes as soon as it answers, or on ${central} once it has been away for 30 s.`;
}

/** How long (ms) after `now` a held message or answer for `s` is sent
 * again: when the 30 s are up, else every few seconds, as the member may
 * answer again or be dropped any moment. */
export function retryIn(s: Session, now: number): number {
  if (!away(s)) return s.owner ? 3_000 : 1_000;
  if (s.pinned) return 5_000;
  return Math.max(1_000, continueWait(s, now) * 1000);
}

interface Held {
  host: string;
  method: string;
  params: Record<string, unknown>;
  /** Sent again now: it can no longer be taken back. */
  sending: boolean;
}

interface HeldState {
  /** What is held, by [`heldKey`]. */
  held: Record<string, Held>;
  /** A held message or answer the central host then refused for good, with
   * why, by [`heldKey`]. */
  failed: Record<string, { line: string; params: Record<string, unknown> }>;
  /** What to say about a session the central host continued for one, by
   * session id: it shows where the session runs now. */
  notes: Record<string, string>;
}

export const useHeld = create<HeldState>(() => ({
  held: {},
  failed: {},
  notes: {},
}));

/** One held message or answer per chat of a host. */
export const heldKey = (host: string, terminal: number, what: What) =>
  `${host}|${terminal}|${what}`;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Session `host` stands for, as its central host lists it now, and that
 * central host's name; null for a host's own session. */
function view(host: string): { session: Session; central: string } | null {
  const copy = parseCopyHost(host);
  if (!copy) return null;
  const st = useApp.getState();
  const session =
    st.data[copy.host]?.sessions.find((s) => s.id === copy.session) ??
    st.data[host]?.sessions.find((s) => s.id === copy.session);
  if (!session) return null;
  return { session, central: st.hosts[copy.host]?.label ?? copy.host };
}

async function attempt(
  host: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Sent> {
  let r: { value: unknown } | { error: unknown };
  try {
    r = { value: await rpc(host, method, params) };
  } catch (error) {
    r = { error };
  }
  const v = view(host);
  if (!v)
    return "value" in r
      ? { kind: "sent", note: null }
      : { kind: "failed", line: `Not sent: ${messageOf(r.error)}` };
  return sentOutcome(r, v.session, v.central);
}

function setHeld(key: string, h: Held | null) {
  useHeld.setState((s) => {
    const held = { ...s.held };
    if (h) held[key] = h;
    else delete held[key];
    return { held };
  });
}

function schedule(key: string) {
  clearTimeout(timers.get(key));
  const h = useHeld.getState().held[key];
  if (!h) return;
  const v = view(h.host);
  timers.set(
    key,
    setTimeout(
      () => void retry(key),
      v ? retryIn(v.session, Date.now()) : 3_000,
    ),
  );
}

async function retry(key: string) {
  timers.delete(key);
  const h = useHeld.getState().held[key];
  if (!h || h.sending) return;
  setHeld(key, { ...h, sending: true });
  const outcome = await attempt(h.host, h.method, h.params);
  settle(key, h, outcome);
  if (outcome.kind === "failed")
    useHeld.setState((s) => ({
      failed: { ...s.failed, [key]: { line: outcome.line, params: h.params } },
    }));
}

function settle(key: string, h: Held, outcome: Sent) {
  if (outcome.kind === "held") {
    setHeld(key, { ...h, sending: false });
    schedule(key);
    return;
  }
  setHeld(key, null);
  const v = view(h.host);
  if (outcome.kind === "sent" && outcome.note && v) {
    const note = outcome.note;
    useHeld.setState((s) => ({ notes: { ...s.notes, [v.session.id]: note } }));
  }
}

/** Sends `method` (`chat.send` or `chat.permission`) with `params` to chat
 * `terminal` of `host`. For a session another member owns, one refused
 * unsent is held and sent again by itself ("held"); one nothing will send
 * throws what to show. */
export async function sendFor(
  host: string,
  terminal: number,
  method: string,
  params: Record<string, unknown>,
  what: What,
): Promise<"sent" | "held"> {
  if (!parseCopyHost(host)) {
    await rpc(host, method, params);
    return "sent";
  }
  const key = heldKey(host, terminal, what);
  // One at a time: what is held already goes first, or is taken back.
  if (useHeld.getState().held[key])
    throw new Error(`Your ${what} before this one is not sent yet.`);
  dismissFailed(key);
  const h: Held = { host, method, params, sending: true };
  setHeld(key, h);
  const outcome = await attempt(host, method, params);
  settle(key, h, outcome);
  if (outcome.kind === "failed") throw new Error(outcome.line);
  return outcome.kind === "held" ? "held" : "sent";
}

/** Takes back what is held for chat `terminal` of `host`, so it is never
 * sent; null while it is being sent, when it can no longer be. */
export function cancelHeld(
  host: string,
  terminal: number,
  what: What,
): Held | null {
  const key = heldKey(host, terminal, what);
  const h = useHeld.getState().held[key];
  if (!h || h.sending) return null;
  clearTimeout(timers.get(key));
  timers.delete(key);
  setHeld(key, null);
  return h;
}

export function dismissFailed(key: string) {
  if (!(key in useHeld.getState().failed)) return;
  useHeld.setState((s) => {
    const failed = { ...s.failed };
    delete failed[key];
    return { failed };
  });
}

export function dismissNote(session: string) {
  if (!(session in useHeld.getState().notes)) return;
  useHeld.setState((s) => {
    const notes = { ...s.notes };
    delete notes[session];
    return { notes };
  });
}

/** The line for what is held for chat `terminal` of `host`, counted down
 * each second, and whether it is being sent, when it can no longer be
 * taken back; null when nothing is held. */
export function useHeldLine(
  host: string,
  terminal: number,
  what: What,
): { line: string; sending: boolean } | null {
  const h = useHeld((s) => s.held[heldKey(host, terminal, what)]);
  const copy = parseCopyHost(host);
  const session = useApp((st) =>
    copy
      ? (st.data[copy.host]?.sessions.find((x) => x.id === copy.session) ??
        st.data[host]?.sessions.find((x) => x.id === copy.session))
      : undefined,
  );
  const central = useApp((st) =>
    copy ? (st.hosts[copy.host]?.label ?? copy.host) : "",
  );
  const now = useNow(1000);
  if (!h || !session) return null;
  return { line: heldLine(session, central, what, now), sending: h.sending };
}
