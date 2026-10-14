import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./index.css";

// Webview problems go to the app log.
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
