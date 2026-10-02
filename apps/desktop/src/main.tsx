import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

window.addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.add("kbd-nav"), true);
window.addEventListener("mousedown", () => document.body.classList.remove("kbd-nav"), true);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
