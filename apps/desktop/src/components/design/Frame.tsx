// What a design system's card and a design's page share (X64, X65): the
// sandboxed frame they render in, and the zoom of the canvas around it.

import { Minus, Plus } from "lucide-react";
import type { Ref } from "react";
import { zoomStep } from "../../lib/designView";
import { cx } from "../../lib/cx";
import { IconButton } from "../ui";

/** A card or a page rendered at `scale`: its viewport, in a frame that may
 *  run its own scripts but never reach the app (no `allow-same-origin`). Not
 *  `live`, the same box without the frame, so its web process (X64) is not
 *  started. `frameRef`: the frame, for a page's bridge (X65). */
export function CardFrame({
  url,
  title,
  viewport,
  scale,
  interactive = false,
  live = true,
  frameRef,
}: {
  url: string;
  title: string;
  viewport: [number, number];
  scale: number;
  interactive?: boolean;
  live?: boolean;
  frameRef?: Ref<HTMLIFrameElement>;
}) {
  const [w, h] = viewport;
  return (
    <div className="relative overflow-hidden" style={{ width: w * scale, height: h * scale }}>
      {live && (
        <iframe
          ref={frameRef}
          title={title}
          src={url}
          sandbox="allow-scripts"
          className={cx("absolute left-0 top-0 border-0 bg-transparent", !interactive && "pointer-events-none")}
          style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0" }}
        />
      )}
    </div>
  );
}

/** − and + by steps from 25% to `max` (400% for a card, 200% for a page),
 *  and the zoom, which fits again on a click (null). `keys`: the canvas
 *  takes ⌘-, ⌘= and ⌘0, so the titles name them. */
export function ZoomBar({ scale, fitted, max, keys = false, onZoom }: { scale: number; fitted: boolean; max: number; keys?: boolean; onZoom: (zoom: number | null) => void }) {
  return (
    <span className="flex items-center gap-0.5">
      <IconButton title={keys ? "Zoom out (⌘-)" : "Zoom out"} disabled={!scale} onClick={() => onZoom(zoomStep(scale, -1, max))}>
        <Minus size={13} />
      </IconButton>
      <button title={keys ? "Fit (⌘0)" : "Fit"} aria-pressed={fitted} className="w-12 rounded text-center font-mono text-faint hover:text-fg" onClick={() => onZoom(null)}>
        {scale ? `${Math.round(scale * 100)}%` : ""}
      </button>
      <IconButton title={keys ? "Zoom in (⌘=)" : "Zoom in"} disabled={!scale} onClick={() => onZoom(zoomStep(scale, 1, max))}>
        <Plus size={13} />
      </IconButton>
    </span>
  );
}
