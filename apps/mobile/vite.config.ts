/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The desktop app's pure logic and small components, shared (ADR 0008).
const desktop = fileURLToPath(new URL("../desktop/src", import.meta.url));

// Tauri expects a fixed port (1420 is the desktop app's) and no screen clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@desktop": desktop },
    // One copy of each, whichever app's folder imports it.
    dedupe: ["react", "react-dom", "zustand", "@tauri-apps/api", "lucide-react", "markdown-it", "dompurify", "highlight.js"],
  },
  server: { port: 1421, strictPort: true, host: process.env.TAURI_DEV_HOST || false, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "safari17", sourcemap: false, chunkSizeWarningLimit: 4000 },
  test: { environment: "jsdom" },
});
