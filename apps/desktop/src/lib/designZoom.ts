// The zoom of a framed page (X110): messages between the app's frame and
// the script the moonlet-design:// scheme puts in every page it serves
// (src-tauri/src/design_zoom.js). Above 100%, the page draws itself at the
// zoom, as WebKit blurs a frame scaled up from the app.

/** Whether a message to the app's window is the zoom script's ask from
 *  `frame`'s own page, not from another frame or the app. */
export function asksZoom(e: { source: unknown; data: unknown }, frame: Window | null | undefined): boolean {
  return !!frame && e.source === frame && e.data === "moonlet:zoom?";
}

/** Tells a page the zoom it draws itself at, 1 when the frame is scaled
 *  instead, and its viewport: the page lays out at that size whether or not
 *  the frame has its new size yet. */
export function zoomMessage(zoom: number, [w, h]: [number, number]): string {
  return `moonlet:zoom=${zoom},${Math.round(w)}x${Math.round(h)}`;
}
