// Opens the sign-ins this Mac's daemon hands the app (X75), with a toast
// that says who asked, and tells the daemon when the user is active here.

import { openUrl } from "@tauri-apps/plugin-opener";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { asksForWaitingSignIns, reportsActive, showAction, signInToast, type BrowserShow } from "./browserRoute";
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
    if (e.name === EV.browserShow) handle(e.host, e.data as BrowserShow);
  }).then(() => {
    // What came while the app was not connected waits with Open (X75).
    void onHostStatus((h) => asksForWaitingSignIns(h) && takeWaiting());
    takeWaiting();
  });
}

function takeWaiting() {
  void rpc<BrowserShow[]>("local", M.browserPending, {})
    .then((shows) => shows.forEach((s) => handle("local", s)))
    .catch(() => {});
}

function handle(host: string, show: BrowserShow) {
  const what = showAction(host, show);
  if (what === "ignore") return;
  const open = () => void openUrl(show.url).catch(errorToast);
  if (what === "offer") {
    // The user is away: it stays until they come back to it.
    toast(`${signInToast(show)} and waits for you`, "info", { label: "Open", run: open }, { sticky: true });
    return;
  }
  open();
  const session = show.session;
  toast(signInToast(show), "info", session ? { label: "Show session", run: () => selectSession(host, session) } : undefined);
}
