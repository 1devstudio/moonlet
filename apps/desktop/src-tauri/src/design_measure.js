// The render check's measuring script (X64). The moonlet-design:// scheme
// puts it first in a card's <head> when the app's render page loads the card
// with ?moonlet-render=<job>. It runs inside the card's sandboxed frame,
// collects raw measurements once the card has loaded, and posts them to the
// render page, which judges them (src/lib/renderRubric.ts). Only the card
// itself can fool it.
(() => {
  const params = new URLSearchParams(location.search);
  const job = params.get("moonlet-render");
  const variant = params.get("variant");
  const errors = [];
  addEventListener(
    "error",
    (e) => {
      const t = e.target;
      if (t && t !== window && t.tagName) {
        errors.push(`${t.tagName.toLowerCase()} did not load: ${t.getAttribute("src") || t.getAttribute("href") || ""}`);
      } else {
        errors.push(String(e.message || "an error"));
      }
    },
    true,
  );
  addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));

  const squash = (s) => s.replace(/\s+/g, " ").trim();
  const DRAWN = new Set(["img", "svg", "canvas", "video", "input", "select", "textarea", "progress", "meter", "hr", "picture", "button"]);
  const seen = (c) => !!c && c !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(c) && !/\/\s*0\)$/.test(c);

  // Something the eye sees: a box with a background, border or shadow, an
  // image or a control.
  function paints(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") return false;
    if (DRAWN.has(el.tagName.toLowerCase())) return true;
    if (seen(s.backgroundColor) || s.backgroundImage !== "none" || s.boxShadow !== "none") return true;
    return ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && seen(s[`border${side}Color`]));
  }

  // The tallest line box of the text under `root`; 0 when none shows.
  function textHeight(root, skip) {
    let max = 0;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.data.trim() || (skip && skip.contains(n))) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) max = Math.max(max, r.height);
    }
    return max;
  }

  const inside = (r, box) => r.left >= box.left - 1 && r.top >= box.top - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1;

  function cellsOf() {
    const cells = [...document.querySelectorAll(".ds-cell")];
    return cells.length ? cells : [...document.querySelectorAll("[data-snippet]")];
  }

  function measure() {
    const marker = [...document.childNodes].find((n) => n.nodeType === Node.COMMENT_NODE && n.data.includes("@dsCard"));
    const name = (marker && /\bname="([^"]*)"/.exec(marker.data)?.[1]) || null;
    const all = cellsOf().filter((c) => getComputedStyle(c).display !== "none");
    const page = all.length === 0;
    const cells = (page ? [document.body] : all).map((cell) => {
      const mount = page ? cell : cell.querySelector(".ds-mount") || cell;
      // A cell without a mount is its own, but for its label.
      const label = mount === cell && !page ? cell.querySelector(":scope > h4") : null;
      const text = squash([...mount.childNodes].filter((n) => n !== label).map((n) => n.textContent || "").join(" "));
      const els = [...mount.querySelectorAll("*")].filter((el) => !(label && label.contains(el)));
      const box = cell.getBoundingClientRect();
      return {
        snippet: page ? null : cell.getAttribute("data-snippet"),
        html: squash(label ? mount.innerHTML.replace(label.outerHTML, "") : mount.innerHTML),
        text,
        empty: els.length === 0 && text === "",
        textHeight: textHeight(mount, label),
        painted: els.filter(paints).length,
        overflow680: 0,
        escaped: page
          ? 0
          : els.filter((el) => {
              const p = getComputedStyle(el).position;
              return (p === "fixed" || p === "absolute") && !inside(el.getBoundingClientRect(), box);
            }).length,
      };
    });
    const fixedOutside = page
      ? 0
      : [...document.body.querySelectorAll("*")].filter((el) => !all.some((c) => c.contains(el)) && getComputedStyle(el).position === "fixed").length;
    // Grid overflow: the page 680 px wide, as design-sync measures it.
    if (!page) {
      const html = document.documentElement;
      const before = html.style.width;
      html.style.width = "680px";
      all.forEach((c, i) => {
        cells[i].overflow680 = Math.max(0, c.scrollWidth - c.clientWidth);
      });
      html.style.width = before;
    }
    return { name, fallback: !!document.querySelector("[data-ds-fallback]"), errors, cells, fixedOutside };
  }

  function send() {
    let metrics;
    try {
      metrics = measure();
    } catch (e) {
      metrics = null;
      errors.push(`the measuring script failed: ${e}`);
    }
    parent.postMessage({ type: "moonlet-render", job, metrics, errors }, "*");
  }

  addEventListener("load", () => {
    // A variant asked for shows alone.
    if (variant) {
      for (const c of cellsOf()) if (c.getAttribute("data-snippet") !== variant) c.style.display = "none";
    }
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    fonts.then(
      () => setTimeout(send, 50),
      () => setTimeout(send, 50),
    );
  });
})();
