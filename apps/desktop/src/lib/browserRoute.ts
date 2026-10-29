// Sign-ins open where you are (X75): a URL a terminal or agent opened, on
// this Mac or another member, that this Mac's daemon hands to the app.

export interface BrowserShow {
  url: string;
  /** The member that asked, by name. */
  from: string;
  session?: string;
  session_name?: string;
  /** The localhost port forwarded for the sign-in to come back. */
  forward?: number;
}

/** The toast's line: who asked. */
export const signInToast = (s: BrowserShow) => `${s.from}${s.session_name ? ` · ${s.session_name}` : ""} opened a sign-in`;

/** Whether the app opens `s`, heard from `host`: only this Mac's daemon
 * says where the user is, and only http and https URLs open. */
export function opensHere(host: string, s: BrowserShow): boolean {
  return host === "local" && /^https?:\/\//i.test(s.url);
}
