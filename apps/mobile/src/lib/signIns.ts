// Sign-ins on the phone (X75): a URL a terminal or agent opened while the
// user was last active here, shown as a card with Open.

import { signInToast, type BrowserShow } from "@desktop/lib/browserRoute";

/** A sign-in waiting on the phone, from host `host`'s central host. */
export interface SignIn {
  host: string;
  show: BrowserShow;
}

/** Whether the phone shows `s`: the central host found the user here. */
export const takesSignIn = (s: BrowserShow) => s.to === "phone" && /^https?:\/\//i.test(s.url);

/** The card's lines: who asked, the page's site, and whether it has to
 * finish on a Mac because it comes back to the asking member's localhost. */
export function signInCard(s: BrowserShow): { title: string; site: string; mac: boolean } {
  let site = s.url;
  try {
    site = new URL(s.url).host;
  } catch {
    // Shown as it came.
  }
  return { title: signInToast(s), site, mac: s.forward !== undefined };
}

/** `list` with `s` first, once per URL. */
export const addSignIn = (list: SignIn[], host: string, s: BrowserShow): SignIn[] => [{ host, show: s }, ...list.filter((x) => x.show.url !== s.url)];
