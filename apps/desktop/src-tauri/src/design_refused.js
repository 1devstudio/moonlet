// The page the moonlet-design:// scheme serves in place of a design's page
// the canvas asked for with the bridge (?moonlet-bridge=1) and that it
// cannot serve: its file missing or unreadable, or refused by the daemon
// (X65 entry 13). It tells the canvas why, from its <meta
// name="moonlet-refused">, at once, as it loads and before WebKit can
// suspend a hidden window's frame, and again whenever the app asks
// (bridge.hello), as the bridge answers. src/lib/designLoad.ts reads it.
(() => {
  const app = window.parent;
  if (!app || app === window) return;
  const meta = document.querySelector('meta[name="moonlet-refused"]');
  const tell = () => app.postMessage({ type: "bridge.failed", reason: meta ? meta.content : "" }, "*");
  tell();
  addEventListener("message", (e) => {
    if (e.source === app && e.data && e.data.type === "bridge.hello") tell();
  });
})();
