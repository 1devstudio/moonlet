// The comment bridge (X65). The moonlet-design:// scheme puts it first in a
// design page's <head> when the design screen's canvas asks for the page with
// ?moonlet-bridge=1. The page is in a sandboxed frame on another origin, so
// the app cannot reach its elements: this script does it for the app, and
// talks to it only through postMessage (src/lib/designBridge.ts checks every
// message it posts).
//
// It reports the page's data-mids once loaded; in Comment mode it outlines
// the element under the pointer, inside the page, and reports a click's
// element (⌥-click: its parent) instead of letting the page have the click;
// it reports the boxes of the pinned elements when asked, and again on load,
// scroll and resize; and it reports C and Esc pressed in the page.
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  const post = (message) => app.postMessage(message, "*");
  const MID = /^m\d+$/;
  const TEXT_MAX = 60;
  let mode = "view";
  let pinned = [];

  const midOf = (el) => el.getAttribute("data-mid") || "";
  /** The nearest element with a data-mid, from `el` outwards. */
  const marked = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (MID.test(midOf(e))) return e;
    return null;
  };
  /** The element an event is about: under the pointer, or with ⌥ its parent. */
  const target = (e) => {
    const el = marked(e.target);
    return el && e.altKey ? marked(el.parentElement) || el : el;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const text = (el) => [...(el.textContent || "").replace(/\s+/g, " ").trim()].slice(0, TEXT_MAX).join("");

  // The outline, drawn in the page over the element, outside its <body> so
  // it is never one of the page's elements.
  let outline = null;
  const draw = (el) => {
    if (!el) {
      if (outline) outline.style.display = "none";
      return;
    }
    if (!outline) {
      outline = document.createElement("moonlet-outline");
      outline.setAttribute("data-moonlet-bridge", "");
      outline.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:1.5px dashed #4c8dff;background:rgba(76,141,255,0.06);border-radius:2px";
      document.documentElement.append(outline);
    }
    const r = box(el);
    Object.assign(outline.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };

  const reportMids = () => post({ type: "bridge.mids", mids: [...new Set([...document.querySelectorAll("[data-mid]")].map(midOf).filter((m) => MID.test(m)))] });
  const reportRects = () => {
    const rects = [];
    for (const mid of pinned) {
      const el = document.querySelector(`[data-mid="${mid}"]`);
      if (el) rects.push({ mid, ...box(el) });
    }
    post({ type: "bridge.rects", rects });
  };
  // Once per frame while the page scrolls or resizes.
  let queued = false;
  const later = window.requestAnimationFrame ? (f) => window.requestAnimationFrame(f) : (f) => setTimeout(f, 16);
  const rectsSoon = () => {
    if (queued || pinned.length === 0) return;
    queued = true;
    later(() => {
      queued = false;
      reportRects();
    });
  };

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", reportMids, { once: true });
  else reportMids();
  addEventListener("load", rectsSoon);
  addEventListener("resize", rectsSoon);
  addEventListener("scroll", rectsSoon, true);

  addEventListener("message", (e) => {
    if (e.source !== app) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "bridge.mode") {
      mode = d.mode === "comment" ? "comment" : "view";
      if (mode !== "comment") draw(null);
    } else if (d.type === "bridge.pins" && Array.isArray(d.mids)) {
      pinned = d.mids.filter((m) => typeof m === "string" && MID.test(m));
      reportRects();
    }
  });

  const hover = (e) => {
    if (mode === "comment") draw(target(e));
  };
  addEventListener("mousemove", hover, true);
  addEventListener("mouseover", hover, true);
  document.addEventListener("mouseleave", () => draw(null));
  // In Comment mode the page never has the pointer's presses: its links,
  // menus and scripts stay as they are while the user picks.
  const swallow = (e) => {
    if (mode !== "comment") return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick"]) addEventListener(name, swallow, true);
  addEventListener(
    "click",
    (e) => {
      if (mode !== "comment") return;
      swallow(e);
      const el = target(e);
      if (el) post({ type: "bridge.pick", mid: midOf(el), tag: el.tagName.toLowerCase(), text: text(el), rect: box(el) });
    },
    true,
  );
  addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const typing = t && t.nodeType === 1 && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
      if (e.key === "Escape") post({ type: "bridge.key", key: "Escape" });
      else if (!typing && (e.key === "c" || e.key === "C") && !e.shiftKey) post({ type: "bridge.key", key: "c" });
    },
    true,
  );
})();
