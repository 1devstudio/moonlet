// The zoom of a page (X110). The moonlet-design:// scheme puts this script in
// every page it serves, after the release script. WebKit draws a frame the
// app scales up at 100% and stretches the picture, which blurs it; so above
// 100% the app makes the frame the zoomed size and asks the page, here, to
// draw itself at the zoom (src/lib/designZoom.ts). The page still lays out
// at its viewport, which the app gives with the zoom.
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
  const own = (name) => {
    for (let o = window; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  };
  const frame = {};
  for (const name of [`innerWidth`, `innerHeight`]) {
    const d = own(name);
    if (!d || !d.get) continue;
    frame[name] = () => d.get.call(window);
    const at = name === `innerWidth` ? 0 : 1;
    if (d.configurable) Object.defineProperty(window, name, { configurable: true, enumerable: d.enumerable, get: () => (zoom === 1 ? frame[name]() : size[at]) });
  }

  const round = (n) => String(Math.round(n * 1000) / 1000);

  // A media query as at the viewport: its lengths are of the frame, so
  // each is times the zoom (an em of a media query is 16 px).
  const written = new WeakMap();
  const scaled = (text) => text.replace(/(\d*\.?\d+)(px|r?em)\b/gi, (_, n, unit) => `${round(Number(n) * (unit.toLowerCase() === `px` ? 1 : 16) * zoom)}px`);
  const fixMedia = (list) => {
    if (!list) return;
    if (!written.has(list)) written.set(list, list.mediaText);
    const text = written.get(list);
    const next = zoom === 1 ? text : scaled(text);
    if (list.mediaText !== next) list.mediaText = next;
  };
  // A declaration as at the viewport: viewport units resolve against the
  // frame and are then zoomed, so each is set in px of the viewport.
  const UNITS = /(-?\d*\.?\d+)[sld]?(vw|vh|vi|vb|vmin|vmax)\b/gi;
  const declared = new WeakMap();
  const inPx = (text, [w, h]) =>
    text.replace(UNITS, (_, n, unit) => {
      const per = { vw: w, vi: w, vh: h, vb: h, vmin: Math.min(w, h), vmax: Math.max(w, h) }[unit.toLowerCase()];
      return `${round((Number(n) * per) / 100)}px`;
    });
  const set = (style, prop, value, priority) => {
    if (style.getPropertyValue(prop) !== value || style.getPropertyPriority(prop) !== priority) style.setProperty(prop, value, priority);
  };
  const unitsOf = (style) => {
    const kept = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      const value = style.getPropertyValue(prop);
      UNITS.lastIndex = 0;
      if (UNITS.test(value)) kept.push([prop, value, style.getPropertyPriority(prop)]);
    }
    return kept;
  };
  const fixKept = (style, kept, size) => {
    for (const [prop, value, priority] of kept) set(style, prop, zoom === 1 ? value : inPx(value, size), priority);
  };
  // The declarations of a rule as the page wrote them, read once.
  const fixStyle = (style, size) => {
    if (!style) return;
    if (!declared.has(style)) declared.set(style, unitsOf(style));
    fixKept(style, declared.get(style), size);
  };
  // The style attribute of an element as the page or the bridge last wrote it:
  // each property with viewport units as written, kept while it still has
  // the value this script gave it.
  const inline = new WeakMap();
  const fixInline = (el, size) => {
    const style = el.style;
    const was = inline.get(el) || new Map();
    const now = new Map();
    for (const [prop, value, priority] of unitsOf(style)) now.set(prop, { value, priority });
    for (const [prop, k] of was) if (!now.has(prop) && style.getPropertyValue(prop) === k.gave) now.set(prop, k);
    for (const [prop, k] of now) {
      k.gave = zoom === 1 ? k.value : inPx(k.value, size);
      set(style, prop, k.gave, k.priority);
    }
    inline.set(el, now);
  };
  // matchMedia, as the page asks it, at the viewport.
  const matchMedia = window.matchMedia;
  if (typeof matchMedia === `function`) {
    window.matchMedia = function (query) {
      const text = String(query);
      const list = matchMedia.call(window, zoom === 1 ? text : scaled(text));
      try {
        Object.defineProperty(list, `media`, { configurable: true, value: text });
      } catch {}
      return list;
    };
  }

  const fixRules = (rules, size) => {
    for (const rule of rules) {
      fixMedia(rule.media);
      fixStyle(rule.style, size);
      if (rule.cssRules) fixRules(rule.cssRules, size);
    }
  };
  // A linked stylesheet of the page cannot be read from it: the page is
  // sandboxed, so its origin is not that of its host. Zoomed, the page gets a
  // copy loaded with CORS (the scheme allows it), which takes the place of
  // the stylesheet once loaded; without it, the stylesheet stays as it is.
  const copied = new WeakSet();
  const readable = (sheet) => {
    try {
      return !!sheet.cssRules;
    } catch {
      return false;
    }
  };
  const copyLinks = () => {
    for (const link of document.querySelectorAll(`link[rel~=stylesheet][href]`)) {
      if (copied.has(link) || link.hasAttribute(`data-moonlet-bridge`) || !link.sheet || readable(link.sheet)) continue;
      copied.add(link);
      const copy = link.cloneNode(false);
      copy.removeAttribute(`id`);
      copy.setAttribute(`data-moonlet-bridge`, ``);
      copy.crossOrigin = `anonymous`;
      copy.addEventListener(`load`, () => {
        link.disabled = true;
        fix();
      });
      copy.addEventListener(`error`, () => copy.remove());
      link.after(copy);
    }
  };

  const fixSheets = () => {
    if (zoom !== 1) copyLinks();
    for (const el of document.querySelectorAll(`[style]`)) if (el !== root) fixInline(el, size);
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      fixMedia(sheet.media);
      fixRules(rules, size);
    }
  };

  // Styles and stylesheets the page or the bridge adds or changes while
  // zoomed: a changed style attribute alone, as a page may animate one each
  // frame; everything once elements are added. The changes of this script
  // are not those of the page.
  const watcher = new MutationObserver((records) => {
    if (zoom === 1) return;
    if (records.some((r) => r.type === `childList`)) return fix();
    for (const r of records) if (r.target !== root && r.target.style) fixInline(r.target, size);
    watcher.takeRecords();
  });
  const fix = () => {
    fixSheets();
    watcher.takeRecords();
  };
  watcher.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [`style`] });
  // A stylesheet that loads after the zoom came.
  addEventListener(`load`, (e) => zoom !== 1 && (e.target === document || e.target instanceof HTMLLinkElement) && fix(), true);

  const apply = (next, viewport) => {
    zoom = next;
    size = viewport;
    if (zoom === 1) root.style.removeProperty(`zoom`);
    else root.style.setProperty(`zoom`, String(zoom), `important`);
    fix();
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
