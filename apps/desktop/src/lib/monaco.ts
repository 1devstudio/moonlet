// Monaco runs fully offline: no CDN loader, one editor worker, no language
// services (syntax colouring only), which keeps memory and startup low.

import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

monaco.editor.defineTheme("jaunt", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#121212",
    "editorGutter.background": "#121212",
    "editor.lineHighlightBackground": "#1a1a1a",
    "diffEditor.insertedTextBackground": "#6fcf8a1f",
    "diffEditor.removedTextBackground": "#ef6b7324",
    "diffEditor.insertedLineBackground": "#6fcf8a12",
    "diffEditor.removedLineBackground": "#ef6b7314",
    "editorWidget.background": "#1a1a1a",
    "scrollbarSlider.background": "#2a2a2a66",
  },
});

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c",
  cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "shell", bash: "shell", zsh: "shell",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", md: "markdown", markdown: "markdown",
  html: "html", css: "css", scss: "scss", less: "less", sql: "sql", xml: "xml", svg: "xml", dockerfile: "dockerfile",
  graphql: "graphql", lua: "lua", r: "r", dart: "dart", ex: "elixir", exs: "elixir", scala: "scala", vue: "html",
};

export function languageFor(path: string): string {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return EXT[name.split(".").pop() ?? ""] ?? "plaintext";
}

export const editorOptions = {
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "line" as const,
  automaticLayout: true,
  smoothScrolling: true,
  stickyScroll: { enabled: false },
  padding: { top: 6 },
};

export { monaco };
