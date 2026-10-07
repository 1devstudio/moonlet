// Syntax colours for the editor (X26): VS Code's TextMate grammars and
// themes through Shiki, turned into Monaco tokens and a Monaco theme. The
// grammars run on Oniguruma (WebAssembly), as in VS Code: WebKit cannot run
// every grammar's patterns as JavaScript regexes. Each grammar and theme is
// its own chunk, loaded the first time it is used.

import { bundledLanguagesInfo, createHighlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { EncodedTokenMetadata, INITIAL, type StateStack } from "shiki/textmate";

export { resolveEditorTheme } from "./editorThemes";

/** Shiki's language ids and aliases (`ts`, `rs`, `yml`…) to its ids. */
const LANGS = new Map<string, string>();
for (const l of bundledLanguagesInfo) for (const k of [l.id, ...(l.aliases ?? [])]) if (!LANGS.has(k)) LANGS.set(k, l.id);

/** Whole file names, lower-cased, whose language is not their extension. */
const NAMES: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zshenv": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
};

/** The editor language of a file: a Shiki language id, or `plaintext`. */
export function editorLanguage(name: string): string {
  const n = name.toLowerCase();
  if (NAMES[n]) return NAMES[n];
  if (/^\.env(\..+)?$/.test(n)) return "dotenv";
  const dot = n.lastIndexOf(".");
  return (dot > 0 && LANGS.get(n.slice(dot + 1))) || "plaintext";
}

/** jaunt's own editor background and diff colours, whatever the theme. */
const OVERRIDES: Record<string, string> = {
  "editor.background": "#121212",
  "editorGutter.background": "#121212",
  "editor.lineHighlightBackground": "#1a1a1a",
  "diffEditor.insertedTextBackground": "#6fcf8a1f",
  "diffEditor.removedTextBackground": "#ef6b7324",
  "diffEditor.insertedLineBackground": "#6fcf8a12",
  "diffEditor.removedLineBackground": "#ef6b7314",
  "editorWidget.background": "#1a1a1a",
  "scrollbarSlider.background": "#2a2a2a66",
};

/** `#abc`, `#abcd`, `#aabbcc` or `#aabbccdd` as six or eight lower-case digits; null otherwise. */
function hex(color: string | undefined): string | null {
  const m = color?.match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  const d = m[1].toLowerCase();
  return d.length <= 4 ? [...d].map((c) => c + c).join("") : d;
}

const FONT_STYLES = ["italic", "bold", "underline", "strikethrough"];

export interface ThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface ThemeData {
  base: "vs-dark";
  inherit: boolean;
  rules: ThemeRule[];
  colors: Record<string, string>;
}

export interface LineTokens {
  tokens: { startIndex: number; scopes: string }[];
  endState: StateStack;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

/**
 * Loads grammars and themes and tokenizes lines for Monaco. Tokens are named
 * `t<colour>` or `t<colour>.f<font style>` after the current theme's colour
 * map, and `theme()` has a rule for each.
 */
export function createSyntax() {
  let highlighter: Promise<Highlighter> | null = null;
  let loaded: Highlighter | null = null;
  let colorMap: string[] = [];
  let current = "";
  const hl = () =>
    (highlighter ??= createHighlighter({ themes: [], langs: [] }).then((h) => (loaded = h)));

  return {
    initial: INITIAL,

    /** Loads a language (`plaintext` needs none) and makes `theme` current. */
    async load(lang: string, theme: string) {
      const h = await hl();
      if (lang !== "plaintext" && !h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as BundledLanguage);
      if (!h.getLoadedThemes().includes(theme)) await h.loadTheme(theme as BundledTheme);
      if (theme !== current) {
        colorMap = h.setTheme(theme as BundledTheme).colorMap;
        current = theme;
      }
    },

    tokenize(lang: string, line: string, state: StateStack): LineTokens {
      const r = loaded!.getLanguage(lang).tokenizeLine2(line, state, 500);
      const tokens = [];
      for (let i = 0; i < r.tokens.length; i += 2) {
        const meta = r.tokens[i + 1];
        const fg = EncodedTokenMetadata.getForeground(meta);
        const style = Math.max(0, EncodedTokenMetadata.getFontStyle(meta));
        tokens.push({ startIndex: r.tokens[i], scopes: style ? `t${fg}.f${style}` : `t${fg}` });
      }
      return { tokens, endState: r.ruleStack };
    },

    /** The current theme as Monaco theme data. */
    theme(): ThemeData {
      const t = loaded!.getTheme(current as BundledTheme);
      const colors: Record<string, string> = {};
      for (const [k, v] of Object.entries(t.colors ?? {})) {
        const c = hex(v);
        if (c) colors[k] = `#${c}`;
      }
      const rules: ThemeRule[] = [{ token: "", foreground: hex(t.fg) ?? undefined }];
      colorMap.forEach((color, i) => {
        const foreground = hex(color);
        if (!foreground) return;
        rules.push({ token: `t${i}`, foreground });
        for (let f = 1; f < 16; f++) rules.push({ token: `t${i}.f${f}`, foreground, fontStyle: FONT_STYLES.filter((_, b) => f & (1 << b)).join(" ") });
      });
      const fg = hex(t.fg);
      return { base: "vs-dark", inherit: true, rules, colors: { ...colors, ...(fg ? { "editor.foreground": `#${fg}` } : {}), ...OVERRIDES } };
    },
  };
}

export type Syntax = ReturnType<typeof createSyntax>;
