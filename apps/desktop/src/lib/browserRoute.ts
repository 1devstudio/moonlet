// Sign-ins open where you are (X75): a URL a terminal or agent opened, on
// this Mac or another member, that this Mac's daemon hands to the app, and
// the activity that tells the daemons where the user is.

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
}

/** The toast's line: who asked. */
export const signInToast = (s: BrowserShow) => `${s.from}${s.session_name ? ` · ${s.session_name}` : ""} opened a sign-in`;

/** What the app does with `s`, heard from `host`: opens it, offers it with
 * Open while it waits, or leaves it, when it is the phone's, not this
 * Mac's daemon's, or not an http or https URL. */
export function showAction(host: string, s: BrowserShow): "open" | "offer" | "ignore" {
  if (host !== "local" || s.to === "phone" || !/^https?:\/\//i.test(s.url)) return "ignore";
  return s.waiting ? "offer" : "open";
}

/** How often at most the app says the user is active. */
export const ACTIVE_EVERY_MS = 30_000;

/** Whether the app says the user is active now, having last said so at
 * `last`. */
export const reportsActive = (last: number | null, now: number) => last === null || now - last >= ACTIVE_EVERY_MS;
