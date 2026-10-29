// Opens the sign-ins this Mac's daemon hands the app (X75), with a toast
// that says who asked.

import { openUrl } from "@tauri-apps/plugin-opener";
import { onDaemonEvent } from "./daemon";
import { opensHere, signInToast, type BrowserShow } from "./browserRoute";
import { EV } from "./protocol";
import { errorToast, selectSession, toast } from "./store";

let started = false;

export function startBrowser() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name !== EV.browserShow) return;
    const show = e.data as BrowserShow;
    if (!opensHere(e.host, show)) return;
    void openUrl(show.url).catch(errorToast);
    const session = show.session;
    toast(signInToast(show), "info", session ? { label: "Show session", run: () => selectSession(e.host, session) } : undefined);
  });
}
