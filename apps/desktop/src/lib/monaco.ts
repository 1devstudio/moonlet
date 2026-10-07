// Monaco runs fully offline: no CDN loader, one editor worker, no language
// services, which keeps memory and startup low. Colours come from Shiki's
// TextMate grammars (X26); Monaco's own definitions give brackets and comments.

import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import type { StateStack } from "shiki/textmate";
import { createSyntax, editorLanguage, resolveEditorTheme } from "./syntax";
import { serial } from "./serial";
import { useStore } from "./store";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Monaco shows the "jaunt" theme until the first file's colours load.
monaco.editor.defineTheme("jaunt", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#121212", "editorGutter.background": "#121212" },
});

const syntax = createSyntax();
const providers = new Set<string>();
let shownTheme = "";

/** Monaco's state between lines: TextMate's rule stack. */
class LineState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone() {
    return new LineState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof LineState && other.stack.equals(this.stack);
  }
}

const C_LIKE: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
};
const HASH: monaco.languages.LanguageConfiguration = { ...C_LIKE, comments: { lineComment: "#" } };
/** Languages Monaco has no definition of that comment with `#`. */
const HASH_LANGS = ["toml", "dotenv", "make", "shellscript", "docker", "nix", "fish", "just", "cmake", "ssh-config", "gitignore"];

/**
 * Loads a language's grammar and the theme and has Monaco use them (X26).
 * Monaco's own definitions still give brackets and comments where it has one.
 * One at a time, so the theme picked last is the one shown.
 */
const prepare = serial(async (lang: string, theme: string) => {
  await syntax.load(lang, theme);
  if (lang !== "plaintext" && !providers.has(lang)) {
    providers.add(lang);
    if (!monaco.languages.getLanguages().some((l) => l.id === lang)) {
      monaco.languages.register({ id: lang });
      monaco.languages.setLanguageConfiguration(lang, HASH_LANGS.includes(lang) ? HASH : C_LIKE);
    }
    monaco.languages.setTokensProvider(lang, {
      getInitialState: () => new LineState(syntax.initial),
      tokenize: (line, state) => {
        const r = syntax.tokenize(lang, line, (state as LineState).stack);
        return { tokens: r.tokens, endState: new LineState(r.endState) };
      },
    });
  }
  if (theme !== shownTheme) {
    shownTheme = theme;
    monaco.editor.defineTheme("jaunt", syntax.theme());
    monaco.editor.setTheme("jaunt");
  }
});

/** The Monaco language of `path`, once its colours are ready; null until then. */
export function useEditorLanguage(path: string | null): string | null {
  const theme = useStore((s) => resolveEditorTheme(s.settings.editorTheme));
  const lang = path ? editorLanguage(path.split("/").pop() ?? "") : null;
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!lang) return;
    let live = true;
    void prepare(lang, theme)
      .catch(() => {})
      .then(() => live && setReady(`${lang}|${theme}`));
    return () => {
      live = false;
    };
  }, [lang, theme]);
  return lang && ready?.startsWith(`${lang}|`) ? lang : null;
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
