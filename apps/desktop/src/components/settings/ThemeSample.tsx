// A few lines of TypeScript in the chosen editor theme (X43, Appearance).

import { useEffect, useState } from "react";
import { createSyntax } from "../../lib/syntax";

const SAMPLE = ["export function total(items: Item[]) {", "  return items.reduce((sum, i) => sum + i.price, 0); // in cents", "}"];

type Span = { text: string; color?: string };

let syntax: ReturnType<typeof createSyntax> | null = null;

async function colour(theme: string): Promise<{ lines: Span[][]; bg?: string }> {
  syntax ??= createSyntax();
  await syntax.load("typescript", theme);
  const t = syntax.theme();
  const fg = new Map(t.rules.map((r) => [r.token, r.foreground]));
  let state = syntax.initial;
  const lines = SAMPLE.map((line) => {
    const r = syntax!.tokenize("typescript", line, state);
    state = r.endState;
    return r.tokens.map((tok, i) => {
      const c = fg.get(tok.scopes) ?? fg.get(tok.scopes.split(".")[0]) ?? fg.get("");
      return { text: line.slice(tok.startIndex, r.tokens[i + 1]?.startIndex ?? line.length), color: c ? `#${c}` : undefined };
    });
  });
  return { lines, bg: t.colors["editor.background"] };
}

export function ThemeSample({ theme }: { theme: string }) {
  const [shown, setShown] = useState<{ lines: Span[][]; bg?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void colour(theme)
      .then((r) => live && setShown(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [theme]);
  return (
    <pre role="img" aria-label="Theme sample" className="m-0 overflow-x-auto rounded-lg bg-panel-2 px-3.5 py-3 font-mono ui-text-12.5 leading-[1.6]" style={shown?.bg ? { background: shown.bg } : undefined}>
      {(shown?.lines ?? SAMPLE.map((l): Span[] => [{ text: l }])).map((spans, i) => (
        <div key={i}>
          {spans.map((s, k) => (
            <span key={k} style={s.color ? { color: s.color } : undefined}>
              {s.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}
