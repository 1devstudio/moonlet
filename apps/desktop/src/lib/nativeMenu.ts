// The webview's own right-click menu offers Back, Forward and Reload, which
// make no sense in the app and can wipe its state. Cancel it everywhere. The
// listener runs in the capture phase, so a handler that stops the event from
// bubbling cannot bring the menu back, and the app's own menus still open.

export function installNoNativeMenu() {
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
}
