// Opens the sign-ins this Mac's daemon hands the app (X75), with a toast
// that says who asked, and tells the daemon when the user is active here.

import { openUrl } from "@tauri-apps/plugin-opener";
import { onDaemonEvent, rpc } from "./daemon";
import { reportsActive, showAction, signInToast, type BrowserShow } from "./browserRoute";
import { EV, M } from "./protocol";
import { errorToast, selectSession, toast } from "./store";

let started = false;
let lastActive: number | null = null;

/** The user did something here: focus, typing or a click. */
function active() {
  const now = Date.now();
  if (!reportsActive(lastActive, now)) return;
  lastActive = now;
  void rpc("local", M.presenceActive, {}).catch(() => {
    lastActive = null;
  });
}

export function startBrowser() {
  if (started) return;
  started = true;
  for (const ev of ["focus", "keydown", "pointerdown"] as const) window.addEventListener(ev, active, { capture: true, passive: true });
  if (document.hasFocus()) active();
  void onDaemonEvent((e) => {
    if (e.name !== EV.browserShow) return;
    const show = e.data as BrowserShow;
    const what = showAction(e.host, show);
    if (what === "ignore") return;
    const open = () => void openUrl(show.url).catch(errorToast);
    if (what === "offer") {
      toast(`${signInToast(show)} and waits for you`, "info", { label: "Open", run: open });
      return;
    }
    open();
    const session = show.session;
    toast(signInToast(show), "info", session ? { label: "Show session", run: () => selectSession(e.host, session) } : undefined);
  });
}
