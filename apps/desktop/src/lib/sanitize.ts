// Text from terminals and agents is untrusted: strip escape sequences and
// control characters before it reaches notifications or the DOM as text.

const ESC_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function sanitize(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  const clean = text.replace(ESC_SEQ, "").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
