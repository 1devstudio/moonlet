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
  const m = /^(\d+)x(\d+)$/.exec(text);
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  return w > 0 && h > 0 ? [w, h] : null;
}

/** A size as `design.toml` keeps it, `WxH`. */
export function viewportText([w, h]: Size): string {
  return `${w}x${h}`;
}

/** What the viewport menu shows: its preset's name, or Custom, and the size. */
export function viewportLabel([w, h]: Size): { name: string; size: string } {
  return { name: VIEWPORTS.find((v) => v.size[0] === w && v.size[1] === h)?.name ?? "Custom", size: `${w}×${h}` };
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
