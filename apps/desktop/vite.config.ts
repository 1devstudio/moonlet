/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari17",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    // The app, and the hidden page that renders design cards (X64).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        render: fileURLToPath(new URL("./render.html", import.meta.url)),
      },
    },
  },
  worker: { format: "es" },
  // Node 25+ has its own localStorage, which hides jsdom's: turn it off.
  test: { environment: "jsdom", execArgv: ["--no-experimental-webstorage"] },
});
