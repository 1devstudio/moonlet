// Sessions follow the user between members (X73): where a session runs,
// what typing into another member's session does, and what Move to…
// offers. The daemons move sessions; these say what the app shows.

import type { ChatImage } from "./attachments";

/** The mark at the end of a session's row: none for a session on this Mac
 * that is not kept here; the host for one running on another member, with
 * a pin when kept there with Move to…, dimmed while that member is offline. */
export function hostMark(
  s: { pinned?: string | null },
  host: string,
  label: string,
  connected: boolean,
  offlineSince?: string,
): { server: boolean; pin: boolean; dim: boolean; tooltip: string } | null {
  const pin = !!s.pinned;
  if (host === "local") return pin ? { server: false, pin: true, dim: false, tooltip: "Kept on this Mac" } : null;
  const where = `${pin ? "Kept on" : "Running on"} ${label}`;
  return { server: true, pin, dim: !connected, tooltip: connected ? where : `${where} · offline${offlineSince ? ` since ${offlineSince}` : ""}` };
}

/** {@link hostMark} for a session row listed from `host`: the central host
 * is offline while this Mac's link cannot reach it (`unreachableSince`),
 * whatever the app's own connection to it says; another host goes by the
 * app's connection (`connected`). */
export function rowMark(
  s: { pinned?: string | null },
  host: string,
  label: string,
  o: { connected: boolean; central: string | null; unreachableSince: number | null },
): ReturnType<typeof hostMark> {
  const cut = host === o.central && o.unreachableSince !== null ? o.unreachableSince : null;
  return hostMark(s, host, label, o.connected && cut === null, cut === null ? undefined : offlineSince(cut));
}

/** Whether typing into a session listed from `host` brings it to this Mac:
 * `host` is another member of this Mac's account, and the session is not
 * kept there. A host outside the account is only talked to where it is. */
export function bringsHere(host: string, accounts: Record<string, { account?: string } | undefined>, s: { pinned?: string | null }): boolean {
  if (host === "local" || s.pinned) return false;
  const mine = accounts.local?.account;
  return !!mine && accounts[host]?.account === mine;
}

/** The composer's line while a typed message waits for the session to
 * move here. */
export const waitingLine = (owner: string) => `Moves here when ${owner}'s turn ends`;

/** Asks `attempt` until the turn running where the session is has ended
 * (X73): an attempt that answers `busy` is asked again every `everyMs`,
 * for up to `waitMs`. `waiting` gets Move now, which asks once with `now`.
 * "done" once an attempt went through, "timeout" when the turn still runs
 * after the wait; any other error is thrown. */
export async function untilTurnEnds(o: {
  attempt: (now: boolean) => Promise<void>;
  waiting: (moveNow: () => void) => void;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  waitMs: number;
  everyMs: number;
}): Promise<"done" | "timeout"> {
  const busy = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "busy";
  try {
    await o.attempt(false);
    return "done";
  } catch (e) {
    if (!busy(e)) throw e;
  }
  // Move now, once pressed: no attempt without `now` after it.
  let now: Promise<void> | null = null;
  const pressed = () => now;
  o.waiting(() => {
    now ??= o.attempt(true);
  });
  const until = o.clock() + o.waitMs;
  while (!pressed() && o.clock() < until) {
    await o.sleep(o.everyMs);
    if (pressed()) break;
    try {
      await o.attempt(false);
      // The turn ended first: Move now has nothing left to move.
      void pressed()?.catch(() => {});
      return "done";
    } catch (e) {
      if (!busy(e)) throw e;
    }
  }
  const moving = pressed();
  if (moving) {
    await moving;
    return "done";
  }
  return "timeout";
}

/** A message typed into chat `terminal` that waits for its session to
 * move here. */
export interface WaitingMessage {
  terminal: number;
  text: string;
  images: ChatImage[];
}

/** One waiting message with `next`, typed into the same chat after it,
 * so both go when the session moves here, in order; null for another
 * chat's. */
export function joinWaiting(waiting: WaitingMessage, next: WaitingMessage): WaitingMessage | null {
  if (next.terminal !== waiting.terminal) return null;
  return { terminal: waiting.terminal, text: `${waiting.text}\n\n${next.text}`, images: [...waiting.images, ...next.images] };
}

/** The host that lists a session after Move to… `to` (a worker id): this
 * Mac (`me`) or the central host. */
export function movedHost(o: { to: string; me: string | null; centralHost: string | null }): string | null {
  return o.to === o.me ? "local" : o.centralHost;
}

/** `HH:MM` of `ms`, as the user's clock shows it. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The line that says the central host is offline. */
export const offlineLine = (name: string, since: number) => `${name} is offline since ${clock(since)}`;

/** The time a member went offline, for a row's tooltip. */
export const offlineSince = (since: number) => clock(since);

/** Move to…'s members: this Mac and the central host, the session's owner
 * checked. None without a central host. */
export function moveTargets(o: { thisMac: string; central: { id: string; label: string } | null; owner: string }): { to: string; label: string; current: boolean }[] {
  if (!o.central) return [];
  return [
    { to: o.thisMac, label: "This Mac", current: o.owner === o.thisMac },
    { to: o.central.id, label: o.central.label, current: o.owner === o.central.id },
  ];
}

/** What a session's menu offers to move it (X73): Move to… this Mac and
 * the central host, Unpin when kept somewhere, and Take over anyway while
 * the central host, which runs it, has been offline 30 s or more and this
 * Mac holds a live copy of it (`copy`) to take it from. */
export function followMenu(o: {
  host: string;
  centralHost: string | null;
  me: string | null;
  centralId: string | null;
  centralLabel: string;
  pinned: boolean;
  unreachableSince: number | null;
  now: number;
  copy: boolean;
}): ({ kind: "move"; to: string; label: string; current: boolean } | { kind: "unpin" } | { kind: "take-over" })[] {
  if (!o.me || !o.centralId || !o.centralHost) return [];
  const owner = o.host === "local" ? o.me : o.host === o.centralHost ? o.centralId : null;
  if (!owner) return [];
  const moves = moveTargets({ thisMac: o.me, central: { id: o.centralId, label: o.centralLabel }, owner }).map((t) => ({ kind: "move" as const, ...t }));
  const offline = o.unreachableSince !== null && o.now - o.unreachableSince >= 30_000;
  return [
    ...(offline ? [] : moves),
    ...(o.pinned && !offline ? [{ kind: "unpin" as const }] : []),
    ...(offline && o.host === o.centralHost && o.copy ? [{ kind: "take-over" as const }] : []),
  ];
}

/** The readiness mark's tooltip: why the central host could not continue
 * session `name` (X73); none when it could, or does not hold a copy. */
export function readyMark(r: { session?: string; ready: boolean; reason?: string | null } | undefined, central: string, name: string): string | null {
  if (!r || r.ready) return null;
  return `${central} could not continue ${name}: ${r.reason ?? "it is not ready"}.`;
}

/** A row of the central host's `session.ready` (X73). */
export type ReadyRow = { session: string; ready: boolean; reason?: string | null };

/** The readiness marks after asking `central` with `ask` (X73), by
 * session: none while there is no central host, it is not connected, or
 * it does not answer, so no mark stays from an earlier answer; null when
 * this Mac's central host (`current`) changed meanwhile, to drop the
 * answer. */
export async function readinessOf(o: {
  central: string | null;
  connected: boolean;
  ask: (central: string) => Promise<ReadyRow[]>;
  current: () => string | null;
}): Promise<Record<string, ReadyRow> | null> {
  if (!o.central || !o.connected) return {};
  let list: ReadyRow[] = [];
  try {
    list = await o.ask(o.central);
  } catch {
    // A central host from before X73 has no answer: no marks.
  }
  if (o.current() !== o.central) return null;
  return Object.fromEntries(list.map((r) => [r.session, r]));
}
