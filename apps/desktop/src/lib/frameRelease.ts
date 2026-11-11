// Removing a design frame without crashing the app (ADR 0013). On macOS
// 27.0.1, WebKit's site isolation crashes the whole app when a frame in a web
// process of its own loses its place in the window (removed, or moved, which
// builds its box again) while its page has a layer clipped by, or held still
// against, an element scrolling inside it: those scrolling tree nodes outlive
// the frame. The page's own process clears them once it draws the page
// without them, which the release script the scheme puts in every page does
// when asked (src-tauri/src/design_release.js). So an element holding a design
// frame is not removed at once: it stays in the window, unseen and out of the
// layout, until each of its frames' pages says it was drawn cleared.

/** The attribute that marks a design frame (`CardFrame`). */
export const FRAME_ATTR = "data-moonlet-frame";

/** What the app asks a page, and what the page answers once it was drawn
 *  hidden (`design_release.js` says the same). */
export const ASK_RELEASE = "moonlet:release";
export const RELEASED = "moonlet:released";

/** How long a page that never says it was drawn cleared (a page that never
 *  stops running, one not loaded yet) keeps its element once the window
 *  shows. */
const WAIT_MS = 1000;

/** Makes `win`'s `removeChild`, which React removes elements with, hold an
 *  element with design frames in it in the window, unseen and out of the
 *  way, ask each frame's page to clear itself, and remove the
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

/** Holds `el`, unseen and out of the way of the pointer, the keyboard,
 *  assistive tech and the layout, until `frames`' pages all said they
 *  cleared, then calls `done`, with no name left on it or inside it. A page
 *  that loads meanwhile is asked again:
 *  it may have missed the first ask. */
function hold(el: HTMLElement, frames: HTMLIFrameElement[], done: () => void) {
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  el.style.position = "absolute";
  el.setAttribute("inert", "");
  el.setAttribute("aria-hidden", "true");
  // Nameless, so nothing finds it by a name the screen it was part of had.
  for (const named of [el, ...el.querySelectorAll("[aria-label], [title], [role]")]) {
    for (const attr of ["aria-label", "title", "role"]) named.removeAttribute(attr);
  }
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const waiting = new Set(frames.map((f) => f.contentWindow));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ask = (f: HTMLIFrameElement) => f.contentWindow?.postMessage(ASK_RELEASE, "*");
  const asks = frames.map((f) => [f, () => ask(f)] as const);
  const finish = () => {
    win?.removeEventListener("message", onMessage);
    doc.removeEventListener("visibilitychange", arm);
    for (const [f, again] of asks) f.removeEventListener("load", again);
    if (timer) clearTimeout(timer);
    done();
  };
  const onMessage = (e: MessageEvent) => {
    if (e.data !== RELEASED || !waiting.delete(e.source as Window)) return;
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
  for (const [f, again] of asks) {
    f.addEventListener("load", again);
    ask(f);
  }
}
