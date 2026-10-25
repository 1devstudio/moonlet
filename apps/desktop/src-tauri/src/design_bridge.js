// The editor bridge (X65), the comment bridge until entry 9. The
// moonlet-design:// scheme puts it first in a design page's <head> when the
// design screen's canvas asks for the page with ?moonlet-bridge=1. The page
// is in a sandboxed frame on another origin, so the app cannot reach its
// elements: this script does it for the app, and talks to it only through
// postMessage (src/lib/designBridge.ts checks every message it posts, and
// this script checks every one it takes, only from the app's window).
//
// It reports the page's data-mids and element tree once loaded, again
// whenever the app asks (bridge.hello), so a report sent before the app
// listened is not lost, and again when the page's scripts add, remove or
// renumber elements; and where it is scrolled, scrolling back where the app
// says after a reload. In Comment mode it outlines the element under the
// pointer, inside the page, and reports a click's element (⌥-click: its
// parent) instead of letting the page have the click; in Edit mode it also
// selects that element, edits the text of one holding only text on a
// double-click, makes the app's edits on the live page, and sends the app
// the editor's keys. It reports the boxes of the pinned elements when asked,
// and again on load, scroll and resize; and C, V and Esc pressed in the
// page. The page's file is never written from here: the app edits the
// page's source and saves it.
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

  // The selection in Edit mode: a solid outline with the element's tag and
  // id over it, drawn like the hover outline, outside the page's <body>.
  let selected = null;
  let selection = null;
  const select = (el) => {
    selected = el;
    drawSelection();
  };
  const drawSelection = () => {
    if (!selected || !selected.isConnected) {
      if (selection) selection.style.display = "none";
      return;
    }
    if (!selection) {
      selection = document.createElement("moonlet-selection");
      selection.setAttribute("data-moonlet-bridge", "selection");
      selection.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:1.5px solid #5b9cff;border-radius:2px";
      const label = document.createElement("span");
      label.style.cssText = "position:absolute;left:-1.5px;bottom:100%;margin-bottom:2px;padding:1px 5px;border-radius:3px;background:#5b9cff;color:#0b1a33;font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap";
      selection.append(label);
      document.documentElement.append(selection);
    }
    const r = box(selected);
    selection.firstChild.textContent = `${selected.tagName.toLowerCase()} · ${midOf(selected)}`;
    Object.assign(selection.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };

  const reportMids = () => post({ type: "bridge.mids", mids: [...new Set([...document.querySelectorAll("[data-mid]")].map(midOf).filter((m) => MID.test(m)))] });

  // The page's tree for the Layers tab: each element of the body with an id,
  // at its depth among them, with the start of its text. The inside of an
  // <svg> and what draws nothing (scripts, styles) are not its elements.
  const QUIET = /^(script|style|template|noscript)$/i;
  const shownText = (el) => {
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 4 * TEXT_MAX; n = walker.nextNode()) {
      // Apart, as each element's text reads: "General Appearance", not
      // "GeneralAppearance" from <a>General</a><a>Appearance</a>.
      if (!n.parentElement || !n.parentElement.closest("script, style, template, noscript")) out += ` ${n.data}`;
    }
    return [...out.replace(/\s+/g, " ").trim()].slice(0, TEXT_MAX).join("");
  };
  const layers = () => {
    const nodes = [];
    const visit = (el, depth) => {
      if (QUIET.test(el.tagName)) return;
      const own = MID.test(midOf(el));
      if (own) nodes.push({ mid: midOf(el), tag: el.tagName.toLowerCase(), depth, text: shownText(el) });
      // An <svg>'s parts are not elements of the page.
      if (el.namespaceURI === "http://www.w3.org/2000/svg") return;
      for (const c of el.children) visit(c, own ? depth + 1 : depth);
    };
    if (document.body) visit(document.body, 0);
    return nodes;
  };
  // An edit by hand made on the live page, as the app made it on the
  // page's source, so it shows at once. True when it was made.
  const byMid = (mid) => (typeof mid === "string" && MID.test(mid) ? document.querySelector(`[data-mid="${mid}"]`) : null);
  const live = (d) => {
    if (d.op === "insert" && typeof d.html === "string") {
      const t = document.createElement("template");
      t.innerHTML = d.html;
      if (d.after === null && document.body) document.body.prepend(t.content);
      else if (byMid(d.after)) byMid(d.after).after(t.content);
      else return false;
      return true;
    }
    const el = byMid(d.mid);
    if (!el || el === document.body) return false;
    if (d.op === "remove") el.remove();
    else if (d.op === "unwrap") el.replaceWith(...el.childNodes);
    else if (d.op === "wrap" && typeof d.box === "string" && MID.test(d.box)) {
      const box = document.createElement("div");
      box.setAttribute("data-mid", d.box);
      el.before(box);
      box.append(el);
    } else return false;
    return true;
  };
  const reportTree = () => post({ type: "bridge.tree", nodes: layers() });
  const loaded = () => {
    reportMids();
    reportTree();
  };
  const reportRects = () => {
    const rects = [];
    for (const mid of pinned) {
      const el = byMid(mid);
      if (el) rects.push({ mid, ...box(el) });
    }
    post({ type: "bridge.rects", rects });
  };
  // Once per frame while the page scrolls or resizes: where it is scrolled
  // (so a reload can come back there), the pinned elements' boxes and the
  // selection's outline.
  let queued = false;
  let scrolled = { x: window.scrollX || 0, y: window.scrollY || 0 };
  const later = window.requestAnimationFrame ? (f) => window.requestAnimationFrame(f) : (f) => setTimeout(f, 16);
  const moved = () => {
    if (queued) return;
    queued = true;
    later(() => {
      queued = false;
      const now = { x: window.scrollX || 0, y: window.scrollY || 0 };
      if (now.x !== scrolled.x || now.y !== scrolled.y) {
        scrolled = now;
        post({ type: "bridge.scroll", ...now });
      }
      if (pinned.length) reportRects();
      drawSelection();
    });
  };

  // Where the app says the page was scrolled before it loaded again: now,
  // and once more when it has loaded, as images may make it longer.
  let restoring = null;
  const scrollBack = (x, y) => {
    scrolled = { x, y };
    window.scrollTo(x, y);
    restoring = document.readyState === "complete" ? null : { x, y };
  };

  // Again after the page's scripts change its elements (a menu, a tab panel
  // or a dialog they add), once a burst of changes ends; the bridge's own
  // outline is no change of the page.
  const own = (n) => n.nodeType === 1 && n.hasAttribute("data-moonlet-bridge");
  const inBridge = (n) => n.nodeType === 1 && !!n.closest("[data-moonlet-bridge]");
  const ofPage = (r) => !inBridge(r.target) && (r.type === "attributes" || ![...r.addedNodes, ...r.removedNodes].every(own));
  let midsTimer = null;
  const watch = () => {
    loaded();
    new MutationObserver((records) => {
      if (!records.some(ofPage)) return;
      clearTimeout(midsTimer);
      midsTimer = setTimeout(loaded, 100);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-mid"] });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  addEventListener("load", () => {
    if (restoring) window.scrollTo(restoring.x, restoring.y);
    restoring = null;
    moved();
  });
  addEventListener("resize", moved);
  addEventListener("scroll", moved, true);

  addEventListener("message", (e) => {
    if (e.source !== app) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "bridge.hello") {
      // Before the page has loaded, its load's report answers.
      if (document.readyState !== "loading") loaded();
    } else if (d.type === "bridge.mode") {
      // Told again after each report of the page's ids: only a new mode
      // ends a text being edited or the selection.
      const next = d.mode === "comment" || d.mode === "edit" ? d.mode : "view";
      if (next === mode) return;
      mode = next;
      finish(true);
      draw(null);
      if (mode !== "edit") select(null);
    } else if (d.type === "bridge.select") {
      // Another selection, from Layers or the breadcrumb, commits the text
      // being edited; the app telling it the one being edited does not.
      if (editing && byMid(d.mid) !== editing) finish(true);
      const el = mode === "edit" ? byMid(d.mid) : null;
      select(el);
      post(el ? { type: "bridge.selected", mid: midOf(el), rect: box(el) } : { type: "bridge.selected", mid: null });
    } else if (d.type === "bridge.scrollTo") {
      if (Number.isFinite(d.x) && Number.isFinite(d.y)) scrollBack(d.x, d.y);
    } else if (d.type === "bridge.edit") {
      if (live(d)) {
        reportTree();
        drawSelection();
      }
    } else if (d.type === "bridge.pins" && Array.isArray(d.mids)) {
      pinned = d.mids.filter((m) => typeof m === "string" && MID.test(m));
      reportRects();
    }
  });

  const hover = (e) => {
    if (mode !== "view") draw(target(e));
  };
  addEventListener("mousemove", hover, true);
  addEventListener("mouseover", hover, true);
  document.addEventListener("mouseleave", () => draw(null));
  // In Comment and Edit mode the page never has the pointer's presses: its
  // links, menus and scripts stay as they are while the user picks.
  const swallow = (e) => {
    // A press outside the text being edited commits it.
    if (editing && !inEdit(e) && (e.type === "pointerdown" || e.type === "mousedown")) finish(true);
    if (mode === "view" || inEdit(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) addEventListener(name, swallow, true);

  // Editing an element's text in place (Edit mode): a double-click on an
  // element that holds only text makes it editable as plain text; Enter or
  // a press outside it commits, and the new text is reported; Esc puts the
  // text back. The page's own handlers never see the presses.
  let editing = null;
  let before = "";
  const inEdit = (e) => !!editing && e.target instanceof Node && editing.contains(e.target);
  const onlyText = (el) => el !== document.body && el.childNodes.length > 0 && [...el.childNodes].every((n) => n.nodeType === Node.TEXT_NODE);
  const finish = (keep) => {
    const el = editing;
    if (!el) return;
    editing = null;
    el.removeAttribute("contenteditable");
    if (!keep) el.textContent = before;
    else if (el.textContent !== before) {
      post({ type: "bridge.text", mid: midOf(el), text: el.textContent });
      reportTree();
    }
    drawSelection();
  };
  // A click outside it in the app takes the focus from the page, or from
  // the element: that commits it too.
  addEventListener("focusout", (e) => {
    if (editing && e.target === editing) finish(true);
  }, true);
  addEventListener("blur", (e) => {
    if (e.target === window) finish(true);
  });
  addEventListener(
    "dblclick",
    (e) => {
      swallow(e);
      if (mode !== "edit" || inEdit(e)) return;
      const el = marked(e.target);
      if (!el || !onlyText(el)) return;
      finish(true);
      editing = el;
      before = el.textContent;
      el.setAttribute("contenteditable", "plaintext-only");
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    },
    true,
  );

  addEventListener(
    "click",
    (e) => {
      if (mode === "view") return;
      swallow(e);
      const el = target(e);
      if (!el) return;
      if (mode === "edit") select(el);
      post({ type: "bridge.pick", mid: midOf(el), tag: el.tagName.toLowerCase(), text: text(el), rect: box(el) });
    },
    true,
  );
  addEventListener(
    "keydown",
    (e) => {
      if (editing) {
        if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          finish(e.key === "Enter");
        }
        return;
      }
      if (e.ctrlKey) return;
      // As the app's isTyping (src/lib/designCanvas.ts), without its
      // terminals: a page has none.
      const t = e.target;
      const typing = !!(t && t.nodeType === 1 && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
      // With ⌥ held, e.key is a composed character; the key's place says
      // which it is, as the app's keyId reads it.
      const key = e.altKey && e.code && e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const send = () => post({ type: "bridge.key", key, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
      const plain = !e.metaKey && !e.altKey && !e.shiftKey;
      if (key === "Escape") return send();
      if (typing) return;
      // C and V switch the mode in any mode, as in the app.
      if (plain && (key === "c" || key === "v")) return send();
      if (mode !== "edit") return;
      // The editor's keys: Tab and ⇧Tab, Delete, ⌘D, ⌥⌘G and ⇧⌥⌘G, ⌘C,
      // ⌘V, ⌘Z and ⇧⌘Z. The page never has them in Edit mode.
      const editor = (key === "Tab" && !e.metaKey && !e.altKey) || ((key === "Delete" || key === "Backspace") && plain) || (e.metaKey && ["d", "g", "c", "v", "z"].includes(key));
      if (!editor) return;
      e.preventDefault();
      send();
    },
    true,
  );
})();
