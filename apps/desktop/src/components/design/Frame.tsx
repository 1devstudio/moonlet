// What a design system's card and a design's page share (X64, X65): the
// sandboxed frame they render in, and the zoom of the canvas around it.

import { Loader2, Minus, Plus } from "lucide-react";
import type { Ref } from "react";
import { zoomStep } from "../../lib/designView";
import { useFrameTurn } from "../../lib/useFrameTurn";
import { cx } from "../../lib/cx";
import { IconButton } from "../ui";

/** A card or a page rendered at `scale`: its viewport, in a frame that may
 *  run its own scripts but never reach the app (no `allow-same-origin`). Not
 *  `live`, the same box without the frame, so its web process (X64) is not
 *  started. The frame loads in its turn, one frame at a time (X64,
 *  `frameQueue.ts`); with `loader`, it shows only once loaded, a spinner
 *  in its place until then. `maxHeight`: the box is cut there, the spinner
 *  centred in what shows. `frameRef`: the frame, for a page's bridge
 *  (X65); `onLoad`: its load, which tells whether the page loaded (X65
 *  entry 13). */
export function CardFrame({
  url,
  title,
  viewport,
  scale,
  interactive = false,
  live = true,
  loader = true,
  maxHeight = Infinity,
  frameRef,
  onLoad,
}: {
  url: string;
  title: string;
  viewport: [number, number];
  scale: number;
  interactive?: boolean;
  live?: boolean;
  loader?: boolean;
  maxHeight?: number;
  frameRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
}) {
  const [w, h] = viewport;
  const turn = useFrameTurn(url, live);
  const hidden = loader && turn.step !== "shown";
  return (
    <div className="relative overflow-hidden" style={{ width: w * scale, height: Math.min(h * scale, maxHeight) }}>
      {live && turn.src !== null && (
        <iframe
          // With the loader, each address gets a frame of its own: WebKit
          // suspends a hidden window's card processes, and a frame sent
          // to a new address in one may not load until the window shows.
          key={loader ? turn.src : undefined}
          ref={frameRef}
          title={title}
          src={turn.src}
          sandbox="allow-scripts"
          onLoad={() => {
            turn.loaded();
            onLoad?.();
          }}
          className={cx("absolute left-0 top-0 border-0 bg-transparent", !interactive && "pointer-events-none", hidden && "invisible")}
          style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0" }}
        />
      )}
      {live && hidden && (
        <span role="status" aria-label={`Loading ${title}`} className="absolute inset-0 flex items-center justify-center text-faint">
          <Loader2 size={16} className="animate-spin" />
        </span>
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
