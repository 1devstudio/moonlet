// Colouring of the shell input editor's command line (T8). A light lexer,
// not a shell parser: it labels words for display only.

export type TokenKind = "space" | "env" | "command" | "subcommand" | "flag" | "string" | "path" | "operator" | "argument";
export interface Token {
  kind: TokenKind;
  text: string;
}

const OPERATORS = ["&&", "||", ">>", "|", ";", "&", ">", "<"];
const REDIRECTS = new Set([">>", ">", "<"]);

/** Splits `input` into labelled tokens whose texts join back to `input`. */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let expectCommand = true;
  let subcommandAllowed = false;
  let redirectTarget = false;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < input.length && /\s/.test(input[j])) {
        if (input[j] === "\n") expectCommand = true;
        j++;
      }
      out.push({ kind: "space", text: input.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      out.push({ kind: "operator", text: op });
      i += op.length;
      if (REDIRECTS.has(op)) redirectTarget = true;
      else {
        expectCommand = true;
        subcommandAllowed = false;
      }
      continue;
    }
    const j = wordEnd(input, i);
    const word = input.slice(i, j);
    i = j;
    out.push({ kind: classify(), text: word });

    function classify(): TokenKind {
      const quoted = word.startsWith('"') || word.startsWith("'");
      if (redirectTarget) {
        redirectTarget = false;
        return quoted ? "string" : pathLike(word) ? "path" : "argument";
      }
      if (expectCommand) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return "env";
        expectCommand = false;
        subcommandAllowed = true;
        return "command";
      }
      const first = subcommandAllowed;
      subcommandAllowed = false;
      if (quoted) return "string";
      if (word.startsWith("-")) return "flag";
      if (pathLike(word)) return "path";
      if (first && /^[A-Za-z0-9_:-]+$/.test(word)) return "subcommand";
      return "argument";
    }
  }
  return out;
}

const pathLike = (w: string) => w.includes("/") || w.startsWith("~") || w.startsWith(".");

/** End of the word starting at `i`: up to whitespace or an operator, with
 * quoted parts (which may hold either) taken whole. An unclosed quote runs
 * to the end. */
function wordEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length && !/\s/.test(s[j]) && !OPERATORS.some((o) => s.startsWith(o, j))) {
    const q = s[j];
    if (q === '"' || q === "'") {
      j++;
      while (j < s.length && s[j] !== q) j += s[j] === "\\" && q === '"' ? 2 : 1;
      j = Math.min(j + 1, s.length);
    } else j += s[j] === "\\" ? 2 : 1;
  }
  return Math.min(j, s.length);
}
