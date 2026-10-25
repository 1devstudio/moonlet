// The app's hidden render page (X64, ADR 0013): the design-render window
// loads it, never shown. The backend hands it a card to render; it frames the
// card in a sandboxed iframe, waits for the measuring script's post, judges it
// with the render rubric and hands the verdict back. The backend then takes
// the window's snapshot when the daemon asked for a screenshot.

import { invoke } from "@tauri-apps/api/core";
import { type RenderJob, type Verdict, handBack, reason, renderUrl, verdict } from "./lib/renderPage";

declare global {
  interface Window {
    moonletRender?: (job: RenderJob) => void;
  }
}

/** How long a card has to load and measure itself. */
const LOAD_MS = 15_000;

const frame = document.getElementById("card") as HTMLIFrameElement;
let current: { id: number; timer: number } | null = null;

/** Into the app's log: this page has no console anyone reads. */
function log(message: string) {
  console.error(message);
  void invoke("log_js", { level: "error", message }).catch(() => {});
}

function answer(id: number, v: Verdict) {
  void handBack(id, v, (cmd, args) => invoke(cmd, args), log);
}

window.moonletRender = (job) => {
  if (current) window.clearTimeout(current.timer);
  frame.style.width = `${job.viewport[0]}px`;
  frame.style.height = `${job.viewport[1]}px`;
  const timer = window.setTimeout(() => {
    if (current?.id !== job.id) return;
    current = null;
    answer(job.id, { error: `the card did not finish loading in ${LOAD_MS / 1000} s` });
  }, LOAD_MS);
  current = { id: job.id, timer };
  frame.src = renderUrl(job);
};

window.addEventListener("message", (e) => {
  // Only the card's own frame, about the card it was asked to render.
  if (!current || e.source !== frame.contentWindow) return;
  const v = verdict(e.data, current.id);
  if (!v) return;
  window.clearTimeout(current.timer);
  const id = current.id;
  current = null;
  answer(id, v);
});

// Ready for cards: the backend sends none before this.
void invoke("design_render_page_ready").catch((e) => log(`the render page could not say it is ready: ${reason(e)}`));
