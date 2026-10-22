import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { hideNativeContextMenu } from "./lib/nativeMenu";
import { invoke } from "@tauri-apps/api/core";

/** Never throws: circular objects and bigints must not break logging. */
function fmt(a: unknown): string {
  if (a instanceof Error) return `${a.message}\n${a.stack}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(a);
  } catch {
    return String(a);
  }
}

// Mirror webview problems into the app log (stderr / Console.app).
for (const level of ["warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    const text = args.map(fmt).join(" ");
    void invoke("log_js", { level, message: text }).catch(() => {});
  };
}
window.addEventListener("error", (e) => console.error(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));

hideNativeContextMenu(window);

window.addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.add("kbd-nav"), true);
window.addEventListener("mousedown", () => document.body.classList.remove("kbd-nav"), true);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
