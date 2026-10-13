// The keys a phone keyboard lacks, above it in the Terminal tab (X40).

export const KEYS = [
  { name: "esc", label: "esc" },
  { name: "tab", label: "tab" },
  { name: "ctrl", label: "ctrl" },
  { name: "up", label: "↑" },
  { name: "down", label: "↓" },
  { name: "left", label: "←" },
  { name: "right", label: "→" },
  { name: "pipe", label: "|" },
  { name: "tilde", label: "~" },
] as const;

const BYTES: Record<string, string> = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pipe: "|",
  tilde: "~",
};

/** What a key sends; `ctrl` sends nothing, it changes the next key. */
export const keyBytes = (name: string): string => BYTES[name] ?? "";

/** Ctrl with a letter or one of `@[\]^_`: its control character, else null. */
export function ctrlBytes(ch: string): string | null {
  const c = ch.toUpperCase().charCodeAt(0);
  if (ch.length !== 1 || c < 0x40 || c > 0x5f) return null;
  return String.fromCharCode(c - 0x40);
}
