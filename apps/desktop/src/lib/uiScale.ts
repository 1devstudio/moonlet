// One font size setting for the whole window: Terminal > Size sets the
// terminals' size, and every other text in the app scales with it.

import { defaultTermSettings } from "./terminals";

/** The font sizes Settings › Terminal › Size allows. */
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

/** The font size `step` pixels away, kept in the allowed range (X37). */
export function stepFontSize(fontSize: number, step: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(fontSize) + step));
}

/** How much the app scales its text: the terminal font size relative to the
 *  default, so 1 at 13px. The root sets it as --ui-scale for the
 *  `ui-text-*` utilities. */
export function uiScale(fontSize: number): number {
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize / defaultTermSettings.fontSize : 1;
}

/** Monaco's font size and line height (Changes diff, code viewer) for a
 *  terminal font size. Lines stay on whole pixels. */
export function editorFont(fontSize: number): { fontSize: number; lineHeight: number } {
  const scale = uiScale(fontSize);
  return { fontSize: 12.5 * scale, lineHeight: Math.round(19 * scale) };
}
