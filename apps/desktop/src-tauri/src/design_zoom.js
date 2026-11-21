// The zoom of a page (X110). The moonlet-design:// scheme puts this script in
// every page it serves, after the release script. WebKit draws a frame the
// app scales up at 100% and stretches the picture, which blurs it; so above
// 100% the app makes the frame the zoomed size and asks the page, here, to
// draw itself at the zoom (src/lib/designZoom.ts). The page still lays out
// at its viewport, which the app gives with the zoom. The bridge, after this
// script, learns the zoom from the moonlet:zoomed event this script sends.
// No quote character anywhere in this file, as in design_release.js.
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  const root = document.documentElement;
  let zoom = 1;
  // The viewport the app gives with the zoom.
  let size = [0, 0];

  // The size of the window as the page reads it: of the viewport, not of
  // the frame.
  const descriptor = (name) => {
    for (let o = window; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  };
  for (const [name, at] of [[`innerWidth`, 0], [`innerHeight`, 1]]) {
    const d = descriptor(name);
    if (!d || !d.get || !d.configurable) continue;
    Object.defineProperty(window, name, { configurable: true, enumerable: d.enumerable, get: () => (zoom === 1 ? d.get.call(window) : size[at]) });
  }

  const round = (n) => String(Math.round(n * 1000) / 1000);

  // A media query as at the viewport: its lengths are of the frame, so
  // each is times the zoom (an em of a media query is 16 px). Kept as the
  // page wrote it, read again once it is not what this script left.
  const media = new WeakMap();
  const scaled = (text) => text.replace(/(\d*\.?\d+)(px|r?em)\b/gi, (_, n, unit) => `${round(Number(n) * (unit.toLowerCase() === `px` ? 1 : 16) * zoom)}px`);
  const fixMedia = (list) => {
    if (!list) return;
    const seen = media.get(list);
    const text = seen && seen.gave === list.mediaText ? seen.text : list.mediaText;
    const gave = zoom === 1 ? text : scaled(text);
    if (list.mediaText !== gave) list.mediaText = gave;
    media.set(list, { text, gave: list.mediaText });
  };

  // A declaration block as at the viewport: viewport units resolve against
  // the frame and are then zoomed, so each is set in px of the viewport.
  // Each property with viewport units is kept as the page or the bridge
  // wrote it, while it still has the value this script gave it.
  const UNITS = /(-?\d*\.?\d+)[sld]?(vw|vh|vi|vb|vmin|vmax)\b/gi;
  const inPx = (text) =>
    text.replace(UNITS, (_, n, unit) => {
      const [w, h] = size;
      const per = { vw: w, vi: w, vh: h, vb: h, vmin: Math.min(w, h), vmax: Math.max(w, h) }[unit.toLowerCase()];
      return `${round((Number(n) * per) / 100)}px`;
    });
  const declared = new WeakMap();
  const fixStyle = (style) => {
    if (!style) return;
    const was = declared.get(style) || new Map();
    const now = new Map();
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      const value = style.getPropertyValue(prop);
      UNITS.lastIndex = 0;
      if (UNITS.test(value)) now.set(prop, { value, priority: style.getPropertyPriority(prop) });
    }
    for (const [prop, k] of was) if (!now.has(prop) && style.getPropertyValue(prop) === k.gave) now.set(prop, k);
    for (const [prop, k] of now) {
      k.gave = zoom === 1 ? k.value : inPx(k.value);
      if (style.getPropertyValue(prop) !== k.gave || style.getPropertyPriority(prop) !== k.priority) style.setProperty(prop, k.gave, k.priority);
      k.gave = style.getPropertyValue(prop);
    }
    declared.set(style, now);
  };

  // matchMedia, as the page asks it, at the viewport.
  const matchMedia = window.matchMedia;
  if (typeof matchMedia === `function`) {
    window.matchMedia = function (query) {
      const text = String(query);
      const at = () => matchMedia.call(window, zoom === 1 ? text : scaled(text));
      const list = at();
      // Its answer at the zoom it is read at; its change events stay those
      // of the zoom it was made at.
      try {
        Object.defineProperty(list, `media`, { configurable: true, value: text });
        Object.defineProperty(list, `matches`, { configurable: true, get: () => at().matches });
      } catch {}
      return list;
    };
  }

  // A linked stylesheet of the page cannot be read from it: the page is
  // sandboxed, so its origin is not that of its host. Zoomed, the page gets a
  // copy loaded with CORS (the scheme allows it for stylesheets), which takes
  // the place of the stylesheet once loaded; without it, the stylesheet stays
  // as it is. Back at 100% the page has its own stylesheets again. A copy is
  // marked as the bridge marks its own elements, so the bridge never takes it
  // for one of the page.
  const copies = new Map();
  const readable = (sheet) => {
    try {
      return !!sheet.cssRules;
    } catch {
      return false;
    }
  };
  const copyLinks = () => {
    for (const link of document.querySelectorAll(`link[rel~=stylesheet][href]`)) {
      if (copies.has(link) || link.hasAttribute(`data-moonlet-bridge`) || !link.sheet || readable(link.sheet)) continue;
      const copy = link.cloneNode(false);
      copy.removeAttribute(`id`);
      copy.setAttribute(`data-moonlet-bridge`, ``);
      copy.crossOrigin = `anonymous`;
      copy.addEventListener(`load`, () => {
        if (copies.get(link) !== copy) return;
        link.disabled = true;
        fix();
      });
      copy.addEventListener(`error`, () => copy.remove());
      copies.set(link, copy);
      link.after(copy);
    }
  };
  const dropCopies = () => {
    for (const [link, copy] of copies) {
      if (copy.isConnected && link.disabled) link.disabled = false;
      copy.remove();
    }
    copies.clear();
  };

  const fixRules = (rules) => {
    for (const rule of rules) {
      fixMedia(rule.media);
      fixStyle(rule.style);
      if (rule.cssRules) fixRules(rule.cssRules);
      // An imported stylesheet, where the page may read it.
      if (rule.styleSheet && readable(rule.styleSheet)) fixRules(rule.styleSheet.cssRules);
    }
  };
  const fixAll = () => {
    if (zoom === 1) dropCopies();
    else copyLinks();
    for (const el of document.querySelectorAll(`[style]`)) fixStyle(el.style);
    for (const sheet of document.styleSheets) {
      fixMedia(sheet.media);
      if (readable(sheet)) fixRules(sheet.cssRules);
    }
  };

  // Styles and stylesheets the page or the bridge adds or changes while
  // zoomed: a changed style attribute alone, as a page may animate one each
  // frame; everything once elements are added. The changes of this script
  // are not those of the page.
  const watcher = new MutationObserver((records) => {
    if (zoom === 1) return;
    if (records.some((r) => r.type === `childList`)) return fix();
    for (const r of records) if (r.target.style) fixStyle(r.target.style);
    watcher.takeRecords();
  });
  const fix = () => {
    fixAll();
    watcher.takeRecords();
  };
  watcher.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [`style`] });
  // A stylesheet that loads after the zoom came: a load of an element
  // reaches the document, never the window.
  document.addEventListener(`load`, (e) => zoom !== 1 && e.target instanceof HTMLLinkElement && fix(), true);
  addEventListener(`load`, () => zoom !== 1 && fix());

  // The zoom the page gives its root itself, if any: given back at 100%.
  let authored = null;
  const apply = (next, viewport) => {
    const was = [innerWidth, innerHeight];
    zoom = next;
    size = viewport;
    if (zoom !== 1) {
      if (!authored) authored = { value: root.style.getPropertyValue(`zoom`), priority: root.style.getPropertyPriority(`zoom`) };
      root.style.setProperty(`zoom`, String(zoom), `important`);
    } else if (authored) {
      if (authored.value) root.style.setProperty(`zoom`, authored.value, authored.priority);
      else root.style.removeProperty(`zoom`);
      authored = null;
    }
    fix();
    dispatchEvent(new CustomEvent(`moonlet:zoomed`, { detail: zoom }));
    // The page reads another window size now, which its frame may not have
    // said yet.
    if (innerWidth !== was[0] || innerHeight !== was[1]) dispatchEvent(new Event(`resize`));
  };

  addEventListener(`message`, (e) => {
    if (e.source !== app || typeof e.data !== `string`) return;
    const m = /^moonlet:zoom=(\d+(?:\.\d+)?),([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(e.data);
    const next = m ? Number(m[1]) : NaN;
    if (!(next >= 1 && next <= 4)) return;
    const viewport = [Number(m[2]), Number(m[3])];
    if (next !== zoom || viewport[0] !== size[0] || viewport[1] !== size[1]) apply(next, viewport);
  });
  app.postMessage(`moonlet:zoom?`, `*`);
})();
