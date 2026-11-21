// The zoom of a framed page (X110): messages between the app's frame and
// the script the moonlet-design:// scheme puts in every page it serves
// (src-tauri/src/design_zoom.js). Above 100%, the page draws itself at the
// zoom, as WebKit blurs a frame scaled up from the app.

/** What the page's zoom script asks when it starts. */
export const ZOOM_ASK = "moonlet:zoom?";

/** Whether a frame's message is its zoom script's ask. */
export function asksZoom(data: unknown): boolean {
  return data === ZOOM_ASK;
}

/** Tells a page the zoom it draws itself at, 1 when the frame is scaled
 *  instead, and its viewport: the page lays out at that size whether or not
 *  the frame has its new size yet. */
export function zoomMessage(zoom: number, [w, h]: [number, number]): string {
  return `moonlet:zoom=${zoom},${Math.round(w)}x${Math.round(h)}`;
}
