// Outside the Tauri webview (Claude Design, previews) there is no
// `window.__TAURI_INTERNALS__`, and every daemon call would throw. This stub
// answers `invoke` with demo data so the app's components render as they do in
// jaunt. Inside the real app it is never installed.

type Handler = (method: string, params: Record<string, unknown>) => unknown;

let rpcHandler: Handler = () => null;

/** Replies for `rpc(method, params)` calls made by components (preview data). */
export function setPreviewRpc(handler: Handler) {
  rpcHandler = handler;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

if (typeof window !== "undefined" && !window.__TAURI_INTERNALS__) {
  let nextId = 1;
  const callbacks = new Map<number, (v: unknown) => void>();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb: (v: unknown) => void) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc(path: string) {
      return path;
    },
    async invoke(cmd: string, args?: Record<string, unknown>) {
      if (cmd === "rpc") {
        const a = (args ?? {}) as { method?: string; params?: Record<string, unknown> };
        return rpcHandler(a.method ?? "", a.params ?? {});
      }
      if (cmd === "host_list") return [];
      if (cmd === "open_targets") return [];
      // Event listeners, notifications, window calls: accept and do nothing.
      return null;
    },
  };
}
