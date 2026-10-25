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
// the editor's keys; it reports the selection's computed style, drags the
// selection to move it, showing an insertion line where it would land,
// resizes it by its handles, and shows where a snippet dragged from the
// app's Palette would drop. It reports the boxes of the pinned elements when asked,
// and again on load, scroll and resize; and C, V and Esc pressed in the
// page. The page's file is never written from here: the app edits the
// page's source and saves it.
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  const post = (message) => app.postMessage(message, "*");
  const MID = /^m\d+$/;
  const TEXT_MAX = 60;
  // The longest text the app takes for an element (designBridge.ts).
  const TEXT_EDIT_MAX = 10000;
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
  // The app says whether the selection is off-system, which its label says.
  let offMark = false;
  const select = (el) => {
    if (el !== selected) offMark = false;
    selected = el;
    drawSelection();
    if (el) reportComputed(el);
  };
  // The selection's computed style, the Inspector's properties of it; a
  // shorthand the browser leaves empty is made from its longhands.
  const COMPUTED = ["display", "flex-direction", "gap", "align-items", "grid-template-columns", "padding", "margin", "width", "height", "background-color", "border", "border-radius", "box-shadow", "opacity", "position"];
  const sides = (vals) => {
    const [t, r, b, l] = vals;
    if (!t) return "";
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    if (r === l) return `${t} ${r} ${b}`;
    return `${t} ${r} ${b} ${l}`;
  };
  const reportComputed = (el) => {
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of COMPUTED) {
      let v = cs.getPropertyValue(p);
      if (!v && (p === "padding" || p === "margin")) v = sides(["top", "right", "bottom", "left"].map((s) => cs.getPropertyValue(`${p}-${s}`)));
      if (!v && p === "border-radius") v = sides(["top-left", "top-right", "bottom-right", "bottom-left"].map((s) => cs.getPropertyValue(`border-${s}-radius`)));
      if (!v && p === "border") {
        const each = ["top", "right", "bottom", "left"].map((s) => ["width", "style", "color"].map((k) => cs.getPropertyValue(`border-${s}-${k}`)).join(" ").trim());
        if (each.every((x) => x === each[0])) v = each[0];
      }
      // No border and no fill read as such, not as their colours.
      if (p === "border" && v && (!/\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(v) || /^0px\b/.test(v))) v = "none";
      if (p === "background-color" && /^rgba\(0, 0, 0, 0\)$/.test(v)) v = "transparent";
      if (v) style[p] = v.trim();
    }
    post({ type: "bridge.computed", mid: midOf(el), style });
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
      // Its handles resize it: they take the pointer, the outline does not.
      for (const [edge, left, top] of [["nw", "0%", "0%"], ["n", "50%", "0%"], ["ne", "100%", "0%"], ["e", "100%", "50%"], ["se", "100%", "100%"], ["s", "50%", "100%"], ["sw", "0%", "100%"], ["w", "0%", "50%"]]) {
        const h = document.createElement("moonlet-handle");
        h.setAttribute("data-moonlet-handle", edge);
        h.style.cssText = `position:absolute;left:${left};top:${top};width:7px;height:7px;margin:-4px 0 0 -4px;box-sizing:border-box;background:#0b1a33;border:1.5px solid #5b9cff;border-radius:1px;pointer-events:auto;cursor:${edge}-resize`;
        selection.append(h);
      }
      document.documentElement.append(selection);
    }
    const r = box(selected);
    selection.firstChild.textContent = `${selected.tagName.toLowerCase()} · ${midOf(selected)}${offMark ? " · off-system" : ""}`;
    selection.firstChild.style.background = offMark ? "#e8a24f" : "#5b9cff";
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
      if (typeof d.above === "string" && byMid(d.above)) byMid(d.above).before(t.content);
      else if (typeof d.into === "string" && byMid(d.into)) byMid(d.into).append(t.content);
      else if (d.above !== undefined || d.into !== undefined) return false;
      else if (d.after === null && document.body) document.body.prepend(t.content);
      else if (byMid(d.after)) byMid(d.after).after(t.content);
      else return false;
      return true;
    }
    const el = byMid(d.mid);
    if (!el || el === document.body) return false;
    if (d.op === "move") {
      const p = d.place && typeof d.place === "object" ? d.place : {};
      const ref = byMid(p.ref);
      if (!ref || el.contains(ref)) return false;
      if (p.where === "above") ref.before(el);
      else if (p.where === "below") ref.after(el);
      else if (p.where === "into") ref.append(el);
      else return false;
    } else if (d.op === "style" && typeof d.style === "string") {
      if (d.style) el.setAttribute("style", d.style);
      else el.removeAttribute("style");
    } else if (d.op === "remove") el.remove();
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
      offMark = !!el && d.off === true;
      drawSelection();
      post(el ? { type: "bridge.selected", mid: midOf(el), rect: box(el) } : { type: "bridge.selected", mid: null });
    } else if (d.type === "bridge.palette") {
      palette = d.dragging === true;
      if (!palette) dropShown(null, null);
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
  // Where a dragged element (or, `dragged` null, a snippet from the app's
  // Palette) would drop at a point: among the children of the element
  // under it, by the side of the one nearest; beside an element that holds
  // only text, or near an edge of a container; into an empty container.
  const EDGE = 6;
  const HOLDS_NONE = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr|svg|math|select|option|textarea|script|style|template|noscript|iframe|object|video|audio|canvas)$/i;
  const holds = (el) => !HOLDS_NONE.test(el.tagName) && !(el.parentElement && el.parentElement.closest("svg, math"));
  const kidsOf = (el, skip) => [...el.children].filter((c) => c !== skip && MID.test(midOf(c)) && !QUIET.test(c.tagName));
  const inRow = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const cs = getComputedStyle(el);
    return /grid$/.test(cs.display) || (/flex$/.test(cs.display) && !/^column/.test(cs.flexDirection || ""));
  };
  const beside = (el, x, y) => {
    const r = box(el);
    const row = inRow(el.parentElement);
    return { where: (row ? x < r.x + r.w / 2 : y < r.y + r.h / 2) ? "above" : "below", ref: midOf(el) };
  };
  const nearEdge = (el, x, y) => {
    const r = box(el);
    return inRow(el.parentElement) ? Math.min(x - r.x, r.x + r.w - x) < EDGE : Math.min(y - r.y, r.y + r.h - y) < EDGE;
  };
  const placeAt = (x, y, dragged) => {
    const t = marked(document.elementFromPoint ? document.elementFromPoint(x, y) : null);
    if (!t || (dragged && dragged.contains(t))) return null;
    const body = t === document.body;
    if (holds(t) && (body || !nearEdge(t, x, y))) {
      const kids = kidsOf(t, dragged);
      if (kids.length) {
        const at = kids.find((c) => beside(c, x, y).where === "above");
        return at ? { where: "above", ref: midOf(at) } : { where: "below", ref: midOf(kids[kids.length - 1]) };
      }
      if (body || !t.textContent.trim()) return { where: "into", ref: midOf(t) };
    }
    return body ? null : beside(t, x, y);
  };
  // Where the dragged element is already: dropping there changes nothing.
  const already = (el, p) =>
    (p.where === "above" && el.nextElementSibling === byMid(p.ref)) || (p.where === "below" && el.previousElementSibling === byMid(p.ref)) || (p.where === "into" && el.parentElement === byMid(p.ref) && el.parentElement.lastElementChild === el);

  // The insertion line, inside the page outside its <body>: at the edge of
  // the element it would land beside, or a box over the container it
  // would go into. The app is told the place when it changes, for its hint.
  let dropLine = null;
  let dropSaid = "";
  const dropShown = (mid, p) => {
    if (!dropLine) {
      dropLine = document.createElement("moonlet-drop");
      dropLine.setAttribute("data-moonlet-bridge", "drop");
      document.documentElement.append(dropLine);
    }
    const ref = p ? byMid(p.ref) : null;
    const said = p ? `${mid} ${p.where} ${p.ref}` : "";
    if (said !== dropSaid) {
      dropSaid = said;
      post({ type: "bridge.drag", mid, place: p ? { where: p.where, ref: p.ref } : null });
    }
    if (!ref) {
      dropLine.style.display = "none";
      return;
    }
    const r = box(ref);
    let at;
    if (p.where === "into") {
      dropLine.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:1.5px dashed #5b9cff;background:rgba(91,156,255,0.08);border-radius:2px";
      at = [r.x, r.y, r.w, r.h];
    } else {
      dropLine.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;background:#5b9cff;border-radius:1px";
      const row = inRow(ref.parentElement);
      const edge = p.where === "above" ? (row ? r.x : r.y) : row ? r.x + r.w : r.y + r.h;
      at = row ? [edge - 1, r.y, 2, r.h] : [r.x, edge - 1, r.w, 2];
    }
    Object.assign(dropLine.style, { display: "block", left: `${at[0]}px`, top: `${at[1]}px`, width: `${at[2]}px`, height: `${at[3]}px` });
  };

  // A press on a handle of the selection resizes it: its width and height
  // in px, shown at once, ⇧ keeping its aspect ratio; the size is reported
  // on release, for the app to write in the page's source.
  let sizing = null;
  // A press on the selection that moves a few px drags it to another place;
  // an absolutely positioned one moves by its left and top instead.
  let drag = null;
  // The click a drag or a resize ends with is no click on the page.
  let justDragged = false;
  const endDrag = () => {
    justDragged = true;
    setTimeout(() => (justDragged = false), 0);
  };
  const cancelDrag = () => {
    if (sizing) Object.assign(sizing.el.style, sizing.style);
    if (drag && drag.abs) Object.assign(drag.el.style, drag.style);
    if (drag && drag.on && !drag.abs) dropShown(midOf(drag.el), null);
    sizing = drag = null;
    drawSelection();
  };
  addEventListener(
    "mousedown",
    (e) => {
      if (mode !== "edit" || !selected || e.button !== 0) return;
      const handle = e.target instanceof Element ? e.target.closest("[data-moonlet-handle]") : null;
      if (handle) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const r = box(selected);
        sizing = { el: selected, edge: handle.getAttribute("data-moonlet-handle"), x: e.clientX, y: e.clientY, w: r.w, h: r.h, style: { width: selected.style.width, height: selected.style.height }, size: null };
        return;
      }
      if (editing || !(e.target instanceof Node) || !selected.contains(e.target)) return;
      const cs = getComputedStyle(selected);
      const abs = /^(absolute|fixed)$/.test(cs.position) ? { left: parseFloat(cs.left) || 0, top: parseFloat(cs.top) || 0 } : null;
      drag = { el: selected, x: e.clientX, y: e.clientY, on: false, abs, style: { left: selected.style.left, top: selected.style.top }, place: null };
    },
    true,
  );
  addEventListener(
    "mousemove",
    (e) => {
      if (sizing) {
        const s = sizing;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        const across = /[ew]/.test(s.edge);
        const down = /[ns]/.test(s.edge);
        let w = s.w + (s.edge.includes("e") ? dx : s.edge.includes("w") ? -dx : 0);
        let h = s.h + (s.edge.includes("s") ? dy : s.edge.includes("n") ? -dy : 0);
        if (e.shiftKey && s.w > 0 && s.h > 0) {
          if (across && (!down || Math.abs(w / s.w - 1) >= Math.abs(h / s.h - 1))) h = (w * s.h) / s.w;
          else w = (h * s.w) / s.h;
        }
        s.size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
        Object.assign(s.el.style, { width: `${s.size.w}px`, height: `${s.size.h}px` });
        drawSelection();
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.on && Math.hypot(dx, dy) < 4) return;
      drag.on = true;
      if (drag.abs) {
        Object.assign(drag.el.style, { left: `${Math.round(drag.abs.left + dx)}px`, top: `${Math.round(drag.abs.top + dy)}px` });
        drawSelection();
        return;
      }
      const p = placeAt(e.clientX, e.clientY, drag.el);
      drag.place = p && !already(drag.el, p) ? p : null;
      dropShown(midOf(drag.el), drag.place);
    },
    true,
  );
  addEventListener(
    "mouseup",
    () => {
      const s = sizing;
      const d = drag;
      sizing = drag = null;
      if (s) {
        endDrag();
        if (s.size) post({ type: "bridge.style", mid: midOf(s.el), set: { width: `${s.size.w}px`, height: `${s.size.h}px` } });
        return;
      }
      if (!d || !d.on) return;
      endDrag();
      if (d.abs) return post({ type: "bridge.style", mid: midOf(d.el), set: { left: d.el.style.left, top: d.el.style.top } });
      dropShown(midOf(d.el), null);
      if (d.place) post({ type: "bridge.move", mid: midOf(d.el), place: d.place });
    },
    true,
  );
  // A snippet dragged from the app's Palette, which the app says: where it
  // would drop shows as for a move, and the drop is reported.
  let palette = false;
  addEventListener("dragover", (e) => {
    if (!palette || mode !== "edit") return;
    e.preventDefault();
    dropShown(null, placeAt(e.clientX, e.clientY, null));
  });
  addEventListener("dragleave", (e) => {
    if (palette && !e.relatedTarget) dropShown(null, null);
  });
  addEventListener("drop", (e) => {
    if (!palette || mode !== "edit") return;
    e.preventDefault();
    const p = placeAt(e.clientX, e.clientY, null);
    dropShown(null, null);
    post({ type: "bridge.drop", place: p });
  });

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
  // a press outside it commits, and the new text is reported; Esc, or a text
  // longer than the app takes, puts the text back. The page's own handlers never see the presses.
  let editing = null;
  let before = "";
  const inEdit = (e) => !!editing && e.target instanceof Node && editing.contains(e.target);
  const onlyText = (el) => el !== document.body && el.childNodes.length > 0 && [...el.childNodes].every((n) => n.nodeType === Node.TEXT_NODE);
  const finish = (keep) => {
    const el = editing;
    if (!el) return;
    editing = null;
    el.removeAttribute("contenteditable");
    // A text longer than the app takes is put back too: the app would
    // never save it, so the page must not show it.
    if (!keep || el.textContent.length > TEXT_EDIT_MAX) el.textContent = before;
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
      if (justDragged) return void (justDragged = false);
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
      if ((sizing || (drag && drag.on)) && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        return cancelDrag();
      }
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
