/** How wide the chat column is, from the X51 design's breakpoints. */
export type InputTier = "wide" | "medium" | "narrow" | "compact";

/** What the chat input and its footer show at a column width (X51). */
export interface InputLayout {
  tier: InputTier;
  /** The column's side padding, px. */
  padX: number;
  /** Where the input's text starts, px; the status line lines up with it. */
  insetX: number;
  /** `· esc to stop` after Working. */
  escHint: boolean;
  /** `⌥↵ ask aside` in the input. */
  asideHint: boolean;
  /** The context ring's percentage. */
  showPercent: boolean;
  /** The spend: `$3.49 · 3M in · 19.9k out`, `$3.49`, or none. */
  cost: "full" | "short" | null;
  /** The effort after the model. */
  effort: boolean;
  /** The permission mode's name beside its icon. */
  modeLabel: boolean;
  /** The idle placeholder that names @ and /. */
  longPlaceholder: boolean;
}

/** `scale` is the app's text scale (see uiScale): larger text needs more room, so the width counts in 1× px. */
export function inputLayout(width: number, scale = 1): InputLayout {
  const w = width / scale;
  const tier: InputTier = w >= 640 ? "wide" : w >= 500 ? "medium" : w >= 380 ? "narrow" : "compact";
  const roomy = tier === "wide" || tier === "medium";
  const compact = tier === "compact";
  return {
    tier,
    padX: compact ? 12 : tier === "narrow" ? 16 : 24,
    insetX: compact ? 12 : 16,
    escHint: roomy,
    asideHint: roomy,
    showPercent: !compact,
    cost: tier === "wide" ? "full" : roomy ? "short" : null,
    effort: roomy,
    modeLabel: !compact,
    longPlaceholder: roomy,
  };
}
