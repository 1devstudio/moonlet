// Playing a design full screen (X99): the page over the whole app window,
// live, at the window's size (Fill) or at the canvas's viewport fitted (Fit),
// ←/→ through the pages, Esc or back to the canvas, and Download.

import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import { isTyping } from "../../lib/designCanvas";
import { pageFile } from "../../lib/designPage";
import type { DesignPlace } from "../../lib/designPlace";
import { downloadNote, playCounter, playFile, playFrame, playKey, playShown, playStep, type Downloaded, type PlayFit, type Size } from "../../lib/designPlay";
import { pageRevOf, useDesign } from "../../lib/designStore";
import { pageUrl, snapshotPageUrl } from "../../lib/designView";
import { keyId } from "../../lib/runActions";
import { errorToast, toast } from "../../lib/store";
import { useSize } from "../../lib/useSize";
import { IconButton, TRAFFIC_LIGHTS } from "../ui";
import { CardFrame } from "./Frame";

/** The page `start` of the design `slug` at `place` played over the whole
 *  window, through `pages`; a snapshot's (`snapshot`) when one is
 *  previewed. `onClose` gets the page last shown. */
export function Play({
  host,
  place,
  slug,
  name,
  pages,
  start,
  snapshot,
  viewport,
  onClose,
}: {
  host: string;
  place: DesignPlace;
  slug: string;
  name: string;
  pages: string[];
  start: string;
  snapshot: number | null;
  viewport: Size;
  onClose: (page: string) => void;
}) {
  const [page, setPage] = useState(start);
  const [fit, setFit] = useState<PlayFit>("fill");
  const [areaRef, area] = useSize<HTMLDivElement>();
  const rev = useDesign((d) => pageRevOf(d, host, place, slug, page));
  // A page that went away shows the first there is; none left, the canvas.
  const shown = playShown(pages, page);
  useEffect(() => {
    if (shown === null) onClose(page);
    else if (shown !== page) setPage(shown);
  }, [shown, page, onClose]);

  // The keyboard's focus on the play bar, and the app behind out of reach,
  // until the play view closes and gives the focus back.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.getElementById("root");
    if (app) app.inert = true;
    bar.current?.querySelector("button")?.focus();
    return () => {
      if (app) app.inert = false;
      before?.focus();
    };
  }, []);

  // Esc and ←/→ before the canvas's own keys, which wait behind the play view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = playKey(keyId(e), isTyping(e.target instanceof Element ? e.target : null));
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (act === "back") onClose(page);
      else setPage((p) => playStep(pages, p, act === "prev" ? -1 : 1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pages, page, onClose]);

  const download = () =>
    void invoke<Downloaded>("design_download", { host, file: playFile(place, slug, page, snapshot), name: pageFile(page) }).then((d) => {
      const note = downloadNote(d);
      if (note) toast(note.text, note.tone);
    }, errorToast);

  const frame = playFrame(area, viewport, fit);
  const url = snapshot === null ? pageUrl(place, slug, page, rev) : snapshotPageUrl(place, slug, snapshot, page);
  return createPortal(
    <div role="dialog" aria-label={`Playing ${name} · ${page}`} className="fixed inset-0 z-[45] flex flex-col bg-bg">
      <div ref={bar} data-tauri-drag-region className="drag flex h-9 shrink-0 items-center gap-2 border-b border-border pr-3 ui-text-13" style={{ paddingLeft: TRAFFIC_LIGHTS }}>
        <IconButton title="Back (Esc)" className="no-drag" onClick={() => onClose(page)}>
          <ArrowLeft size={14} />
        </IconButton>
        <span className="truncate text-fg">
          {name} · {page}
        </span>
        <span className="font-mono ui-text-12 text-faint">{playCounter(pages, page)}</span>
        <IconButton title="Download as HTML" className="no-drag ml-auto" onClick={download}>
          <Download size={14} />
        </IconButton>
        <div role="group" aria-label="Play size" className="no-drag flex h-7 items-center rounded-md border border-border-strong p-0.5">
          {(["fill", "fit"] as const).map((f) => (
            <button key={f} aria-pressed={fit === f} onClick={() => setFit(f)} className={cx("h-full rounded px-2.5", fit === f ? "bg-raised text-fg" : "text-muted hover:text-fg")}>
              {f === "fill" ? "Fill" : "Fit"}
            </button>
          ))}
        </div>
      </div>
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {area[0] > 0 && <CardFrame key={`${page}@${snapshot}`} url={url} title={`${pageFile(page)} played`} viewport={frame.size} scale={frame.scale} interactive loader={false} />}
      </div>
    </div>,
    document.body,
  );
}
