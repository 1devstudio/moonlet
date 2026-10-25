// The design canvas's viewport and zoom (X65). Pure: the screen is
// components/design/DesignScreen.tsx.

import { fitScale, zoomStep } from "./designView";

/** A viewport's width and height, in px. */
export type Size = [number, number];

/** The viewport menu's presets. */
export const VIEWPORTS: { name: string; size: Size }[] = [
  { name: "Desktop", size: [1440, 900] },
  { name: "Laptop", size: [1280, 800] },
  { name: "Tablet", size: [834, 1112] },
  { name: "Phone", size: [390, 844] },
];

/** `WxH` as `design.toml` keeps it, or null when it is no size. */
export function parseViewport(text: string): Size | null {
  const [w, h, ...rest] = text.split("x");
  return rest.length || h === undefined ? null : sizeOf(w, h);
}

/** A width and a height as typed, each whole px above 0, or null. */
export function sizeOf(width: string, height: string): Size | null {
  const px = (n: string) => (/^\d+$/.test(n) && Number(n) > 0 ? Number(n) : null);
  const [w, h] = [px(width), px(height)];
  return w !== null && h !== null ? [w, h] : null;
}

/** A size as `design.toml` keeps it, `WxH`. */
export function viewportText([w, h]: Size): string {
  return `${w}x${h}`;
}

/** The preset of a size, if it is one. */
function presetOf([w, h]: Size): { name: string; size: Size } | undefined {
  return VIEWPORTS.find((v) => v.size[0] === w && v.size[1] === h);
}

/** A size as the viewport menu shows it, `W×H`. */
export function sizeText([w, h]: Size): string {
  return `${w}×${h}`;
}

/** What the viewport menu shows: its preset's name, or Custom, and the size. */
export function viewportLabel(size: Size): { name: string; size: string } {
  return { name: presetOf(size)?.name ?? "Custom", size: sizeText(size) };
}

/** How many custom sizes the settings keep. */
const CUSTOM_KEPT = 5;

/** The user's custom sizes, from the app's settings (`WxH`, newest first),
 *  listed after the presets: a size that is none or a preset's is left out,
 *  and settings from before they were kept list none. */
export function customViewports(saved: string[] | undefined): Size[] {
  return (saved ?? []).flatMap((text) => {
    const size = parseViewport(text);
    return size && !presetOf(size) ? [size] : [];
  });
}

/** The custom sizes the settings keep after the user picks `size`: it first,
 *  once; a preset's is not kept; at most five. */
export function withCustomViewport(saved: string[] | undefined, size: Size): string[] {
  const kept = customViewports(saved).map(viewportText);
  if (presetOf(size)) return kept;
  const text = viewportText(size);
  return [text, ...kept.filter((t) => t !== text)].slice(0, CUSTOM_KEPT);
}

/** The canvas's scale: `zoom` once the user zoomed, else the viewport
 *  fitted into `box` (at most 200%); 0 while there is no room yet. */
export function canvasScale(zoom: number | null, viewport: Size, box: Size): number {
  if (zoom !== null) return zoom;
  return box[0] > 0 && box[1] > 0 ? fitScale(viewport, box) : 0;
}

/** − and +: the next step from `zoom`, within 25%–200%. */
export function canvasZoom(zoom: number, dir: 1 | -1): number {
  return zoomStep(zoom, dir, 2);
}

export type CanvasKey = "fit" | "in" | "out" | "chat";

/** The keys the design screen takes from the app while it is shown: ⌘0
 *  fits, ⌘= and ⌘- zoom, ⌘\\ folds the chat panel. */
export function canvasKey(id: string): CanvasKey | null {
  if (id === "cmd+0") return "fit";
  if (["cmd+=", "shift+cmd+=", "cmd++", "shift+cmd++"].includes(id)) return "in";
  if (id === "cmd+-") return "out";
  if (id === "cmd+\\") return "chat";
  return null;
}
