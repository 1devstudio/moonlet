// The page the moonlet-design:// scheme serves in place of a design's page
// the canvas asked for with the bridge (?moonlet-bridge=1) and that it
// cannot serve: its file missing or unreadable, or refused by the daemon
// (X65 entry 13). It tells the canvas that it failed, at once, as it loads
// and before WebKit can suspend a hidden window's frame, and again
// whenever the app asks (bridge.hello), as the bridge answers. It says no
// why: a page's own scripts could post the same, so the app asks the daemon
// why (src/lib/designLoad.ts).
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  const tell = () => app.postMessage({ type: "bridge.failed" }, "*");
  tell();
  addEventListener("message", (e) => {
    if (e.source === app && e.data && e.data.type === "bridge.hello") tell();
  });
})();
