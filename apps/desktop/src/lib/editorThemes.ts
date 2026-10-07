// The editor's colour theme setting (X26). Apart from the syntax module, so
// Settings lists the themes without loading Shiki itself.

import { bundledThemesInfo } from "shiki/themes";

export const DEFAULT_EDITOR_THEME = "dark-plus";

/** The dark themes the setting offers, by label. */
export const EDITOR_THEMES = bundledThemesInfo
  .filter((t) => t.type === "dark")
  .map((t) => ({ id: t.id, label: t.displayName }))
  .sort((a, b) => a.label.localeCompare(b.label));

export function resolveEditorTheme(value: unknown): string {
  return EDITOR_THEMES.find((t) => t.id === value)?.id ?? DEFAULT_EDITOR_THEME;
}
