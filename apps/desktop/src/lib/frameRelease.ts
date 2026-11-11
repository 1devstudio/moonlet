// Removing a design frame without crashing the app (ADR 0013). On macOS
// 27.0.1, WebKit's site isolation crashes the whole app when a frame in a web
// process of its own loses its place in the window (removed, or moved, which
// builds its box again) while its page has a layer clipped by, or held still
// against, an element scrolling inside it: those scrolling tree nodes outlive
// the frame. The page's own process clears them once it draws the page
// without them, which the release script the scheme puts in every page does
// when asked (src-tauri/src/design_release.js). So an element holding a design
// frame is not removed at once: it stays where it is, unseen, until each of
// its frames' pages says it was drawn cleared.

/** The attribute that marks a design frame (`CardFrame`). */
export const FRAME_ATTR = "data-moonlet-frame";

/** How long a page that never says it was drawn cleared (a page that never
 *  stops running, one not loaded yet) keeps its element once the window
 *  shows. */
const WAIT_MS = 1000;

/** Makes `win`'s `removeChild`, which React removes elements with, hold an
 *  element with design frames in it where it is, unseen and out of the
 *  pointer's way, ask each frame's page to clear itself, and remove the
 *  element once every page said it did, or [`WAIT_MS`] after the window
 *  shows: a hidden window draws nothing, so its pages cannot clear
 *  themselves until it shows again. Anything else is removed at once. */
export function holdFramesOnRemove(win: Window & typeof globalThis) {
  const proto = win.Node.prototype;
  const remove = proto.removeChild;
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    const frames = framesIn(child);
    if (!frames.length) return remove.call(this, child) as T;
    hold(child as unknown as HTMLElement, frames, () => {
      if (child.parentNode) remove.call(child.parentNode, child);
    });
    return child;
  };
}

/** The design frames `node` is or holds. */
function framesIn(node: Node): HTMLIFrameElement[] {
  if (!(node instanceof Element)) return [];
  if (node.tagName === "IFRAME" && node.hasAttribute(FRAME_ATTR)) return [node as HTMLIFrameElement];
  return [...node.querySelectorAll<HTMLIFrameElement>(`iframe[${FRAME_ATTR}]`)];
}

/** Holds `el`, unseen, until `frames`' pages all said they cleared, then
 *  calls `done`. */
function hold(el: HTMLElement, frames: HTMLIFrameElement[], done: () => void) {
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const waiting = new Set(frames.map((f) => f.contentWindow));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    win?.removeEventListener("message", onMessage);
    doc.removeEventListener("visibilitychange", arm);
    if (timer) clearTimeout(timer);
    done();
  };
  const onMessage = (e: MessageEvent) => {
    if (e.data !== "moonlet:released" || !waiting.delete(e.source as Window)) return;
    if (!waiting.size) finish();
  };
  const arm = () => {
    if (doc.visibilityState !== "visible") {
      if (timer) clearTimeout(timer);
      timer = null;
    } else timer ??= setTimeout(finish, WAIT_MS);
  };
  win?.addEventListener("message", onMessage);
  doc.addEventListener("visibilitychange", arm);
  arm();
  for (const f of frames) f.contentWindow?.postMessage("moonlet:release", "*");
}
