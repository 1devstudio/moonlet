// Letting a frame go (ADR 0013). The moonlet-design:// scheme puts this
// script first in every page it serves. On macOS 27.0.1, WebKit site
// isolation crashes the whole app when a frame in its own web process is let
// go while its page has a layer clipped by, or held still against, an
// element scrolling inside it: those scrolling tree nodes outlive the frame.
// They go away once the page is drawn without them, in its own process, so
// before the app lets a frame go it asks this script to hide the whole page,
// and waits for it to say the page was drawn hidden (src/lib/frameRelease.ts).
// No quote character anywhere in this file: a page whose attribute quote is
// never closed must still swallow what comes after it (X65 entry 13).
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  addEventListener(`message`, (e) => {
    if (e.source !== app || e.data !== `moonlet:release`) return;
    document.documentElement.style.setProperty(`display`, `none`, `important`);
    // The second frame callback runs once the first frame was drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => app.postMessage(`moonlet:released`, `*`)));
  });
})();
