// How moonlet gets the user's attention for an agent event (A3, X10, X47).

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
}

export function alertFor(i: AlertInput): Alert {
  const burst = i.state === "done" && i.lastDoneAt !== undefined && i.now - i.lastDoneAt < DONE_BURST_MS;
  if (burst) return { sound: null, banner: false };
  const sound = i.visible || i.settings.muted ? null : soundFor(i.settings.sounds, i.state);
  const banner = bannerOn(i.settings.banners, i.state) && (!i.focused || (i.settings.notifyWhenFocused && !i.visible));
  return { sound, banner };
}
