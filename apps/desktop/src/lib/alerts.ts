// How moonlet gets the user's attention for an agent event (A3, X10, X47).

import type { DesignTag } from "./protocol";
import { soundFor, type SoundEvent, type SoundSettings } from "./sounds";

/** Another "done" for the same session this soon after the last one stays silent (X47). */
export const DONE_BURST_MS = 90_000;

/** Desktop notification per event, on unless set to false (X47). */
export type BannerSettings = Record<SoundEvent, boolean>;

export interface AlertSettings {
  notifyWhenFocused: boolean;
  sounds?: Partial<SoundSettings>;
  banners?: Partial<BannerSettings>;
  /** Every sound off, from the bell in the sidebar footer (X47). */
  muted?: boolean;
}

/** Whether an event sends a desktop notification at all. */
export function bannerOn(banners: Partial<BannerSettings> | undefined, state: string): boolean {
  return banners?.[state as SoundEvent] !== false;
}

export interface AlertInput {
  /** The agent state of the `agent.attention` event. */
  state: string;
  /** moonlet's window has focus. */
  focused: boolean;
  /** The agent's tab is the one on screen. */
  visible: boolean;
  settings: AlertSettings;
  /** When this session last alerted a "done", in ms. */
  lastDoneAt?: number;
  now: number;
}

export interface Alert {
  /** The system sound to play, or null. */
  sound: string | null;
  /** Whether to send a desktop notification. */
  banner: boolean;
  /** Whether the agent's tab gets the unread mark, also when the alert is silenced. */
  unread: boolean;
}

export function alertFor(input: AlertInput): Alert {
  const { state, focused, visible, settings, lastDoneAt, now } = input;
  const unread = !visible;
  if (state === "done" && lastDoneAt !== undefined && now - lastDoneAt < DONE_BURST_MS) return { sound: null, banner: false, unread };
  const sound = visible || settings.muted ? null : soundFor(settings.sounds, state);
  const banner = bannerOn(settings.banners, state) && (!focused || (settings.notifyWhenFocused && !visible));
  return { sound, banner, unread };
}

/** Each session's last alerted "done", for the burst rule (X47). */
export class DoneBursts {
  private last = new Map<string, number>();

  /** The alert for an event of `session`. A "done" that alerts starts a new burst. */
  alert(session: string, input: Omit<AlertInput, "lastDoneAt">): Alert {
    const a = alertFor({ ...input, lastDoneAt: this.last.get(session) });
    if (input.state === "done" && (a.sound || a.banner)) this.last.set(session, input.now);
    return a;
  }

  /** The user looked at `session`: its next "done" alerts again. */
  seen(session: string) {
    this.last.delete(session);
  }
}

/** How files that start to differ between the central host and this Mac
 * get the user's attention (X60): a desktop notification as for an agent,
 * under its own switch; while moonlet is in front, a toast instead, unless
 * notifications are wanted there too. */
export function differsAlert(o: { focused: boolean; notifyWhenFocused: boolean; banner: boolean }): { banner: boolean; toast: boolean } {
  const banner = o.banner && (!o.focused || o.notifyWhenFocused);
  return { banner, toast: o.banner && !banner };
}

/** Whether an agent's `agent.attention` alerts as a session's does (X47).
 *  The daemon tags a design system's sync agent `design: {kind: "sync"}`
 *  (`design: true` before X65 entry 7a): Design mode notifies for it, when it
 *  asks or the sync is done, never per turn. A design's agent notifies like a
 *  session's (X65). */
export function alertsLikeASession(a: { design?: DesignTag }): boolean {
  return !(a.design === true || (typeof a.design === "object" && a.design.kind === "sync"));
}
