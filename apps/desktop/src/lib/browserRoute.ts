// Sign-ins open where you are (X75): a URL a terminal or agent opened, on
// this Mac or another member, that this Mac's daemon hands to the app, and
// the activity that tells the daemons where the user is.

import type { HostInfo } from "./protocol";

export interface BrowserShow {
  url: string;
  /** The member that asked, by name. */
  from: string;
  session?: string;
  session_name?: string;
  /** The localhost port forwarded for the sign-in to come back. */
  forward?: number;
  /** "phone" when the phone, which the user used last, opens it. */
  to?: string;
  /** Nobody was active lately: it waits for Open. */
  waiting?: boolean;
  /** The forward's port is taken on this Mac: it waits for Retry. */
  port_taken?: boolean;
}

/** The toast's line: who asked. */
export const signInToast = (s: BrowserShow) => `${s.from}${s.session_name ? ` · ${s.session_name}` : ""} opened a sign-in`;

/** What the app does with `s`, heard from `host`: opens it, offers it with
 * Open while it waits, or leaves it, when it is the phone's, not this
 * Mac's daemon's, or not an http or https URL. */
export function showAction(host: string, s: BrowserShow): "open" | "offer" | "taken" | "ignore" {
  if (host !== "local" || s.to === "phone" || !/^https?:\/\//i.test(s.url)) return "ignore";
  if (s.port_taken) return "taken";
  return s.waiting ? "offer" : "open";
}

/** What the app says when the sign-in's port is taken on this Mac. */
export const portTakenLine = (s: BrowserShow) => `Port ${s.forward} is in use on this Mac, so the sign-in for ${s.from} can't come back here. Close what uses it and press Retry.`;

/** How often at most the app says the user is active. */
export const ACTIVE_EVERY_MS = 30_000;

/** Whether the app says the user is active now, having last said so at
 * `last`. */
export const reportsActive = (last: number | null, now: number) => last === null || now - last >= ACTIVE_EVERY_MS;

/** Whether the app asks `h` for the sign-ins that came while it was not
 * connected: this Mac's own daemon, each time it connects. */
export const asksForWaitingSignIns = (h: Pick<HostInfo, "id" | "status">) => h.id === "local" && h.status === "connected";
