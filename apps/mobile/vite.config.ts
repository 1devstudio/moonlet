/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { splashHtml } from "./src/lib/splash";

// The desktop app's pure logic and small components, shared (ADR 0008).
const desktop = fileURLToPath(new URL("../desktop/src", import.meta.url));

// Tauri expects a fixed port (1420 is the desktop app's) and no screen clearing.
// index.html shows the splash until the app's script replaces it, so the
// iOS launch screen hands over without a blank frame (X40).
const splash = {
  name: "moonlet-splash",
  transformIndexHtml(html: string) {
    const moon = readFileSync(new URL("./src/assets/moon.svg", import.meta.url), "utf8").trim();
    return html.replace('<div id="root"></div>', `<div id="root">${splashHtml(moon)}</div>`);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), splash],
  clearScreen: false,
  resolve: {
    alias: { "@desktop": desktop },
    // One copy of each, whichever app's folder imports it.
    dedupe: ["react", "react-dom", "zustand", "@tauri-apps/api", "lucide-react", "markdown-it", "dompurify", "highlight.js"],
  },
  server: { port: 1421, strictPort: true, host: process.env.TAURI_DEV_HOST || false, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "safari17", sourcemap: false, chunkSizeWarningLimit: 4000 },
  // Node 25+ has its own localStorage, which hides jsdom's: turn it off.
  test: { environment: "jsdom", execArgv: ["--no-experimental-webstorage"] },
});
