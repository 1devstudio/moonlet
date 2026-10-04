// Library build of jaunt's design system (src/ds) for Claude Design sync.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Diagrams are app-only (Markdown preview); keep mermaid out of the bundle.
    alias: { mermaid: fileURLToPath(new URL("./src/ds/no-mermaid.ts", import.meta.url)) },
  },
  build: {
    outDir: "ds/dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    lib: { entry: "src/ds/index.ts", formats: ["es"], fileName: "index", cssFileName: "styles" },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
      output: { codeSplitting: false },
    },
  },
});
