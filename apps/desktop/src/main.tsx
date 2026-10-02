import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { invoke } from "@tauri-apps/api/core";

// Mirror webview problems into the app log (stderr / Console.app).
for (const level of ["warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    void invoke("log_js", { level, message: text }).catch(() => {});
  };
}
window.addEventListener("error", (e) => console.error(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));

window.addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.add("kbd-nav"), true);
window.addEventListener("mousedown", () => document.body.classList.remove("kbd-nav"), true);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
