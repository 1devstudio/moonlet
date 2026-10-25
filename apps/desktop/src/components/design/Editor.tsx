// The design screen's visual editor (X65): the right rail's Layers tab, the
// selection's breadcrumb over the page, the edits by hand chip, and a
// message of the user's that carries edits by hand, shown in the chat.
// What they decide is in lib/designCanvas.ts and lib/designEdits.ts.

import { ChevronRight, Pencil } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import type { Layer } from "../../lib/designBridge";
import { lineRead, type EditLineRead } from "../../lib/designEdits";
import { cx } from "../../lib/cx";

/** The selection's blue, as the page's outline draws it. */
const SELECTED = "bg-[rgba(91,156,255,0.16)] text-[#cfe0ff]";

/** The Layers tab: the page's element tree, each element with its tag, the
 *  start of its text and its id; a click selects it on the canvas. */
export function LayersTab({ layers, selected, onSelect }: { layers: Layer[]; selected: string | null; onSelect: (mid: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  if (layers.length === 0) return <p className="px-4 py-6 text-center ui-text-12.5 text-faint">The page's elements show here once it has loaded.</p>;
  return (
    <div ref={list} role="tree" aria-label="Layers" className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 font-mono ui-text-12">
      {layers.map((l, i) => {
        const parent = (layers[i + 1]?.depth ?? -1) > l.depth;
        return (
          <button
            key={l.mid}
            role="treeitem"
            aria-label={`${l.tag} ${l.mid}`}
            aria-current={selected === l.mid ? "true" : undefined}
            onClick={() => onSelect(l.mid)}
            className={cx("flex h-[26px] w-full items-center gap-1.5 rounded-[5px] pr-2 text-left", selected === l.mid ? SELECTED : "text-fg hover:bg-panel-2")}
            style={{ paddingLeft: 6 + l.depth * 14 }}
          >
            <span className="w-2.5 shrink-0 text-faint">{parent ? "▾" : ""}</span>
            <span className="shrink-0">{l.tag}</span>
            <span className="min-w-0 flex-1 truncate font-sans text-muted">{l.text}</span>
            <span className="shrink-0 ui-text-11 text-faint">{l.mid}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The selection's ancestors over the page, `body › main m20 › section
 *  m24`; a click selects one. The hint says what Edit does. */
export function Breadcrumb({ path, hint, onSelect }: { path: { mid: string; label: string }[]; hint: string; onSelect: (mid: string) => void }) {
  return (
    <nav aria-label="Selection" className="flex min-w-0 flex-1 items-center gap-1.5 font-mono ui-text-12 text-muted">
      {path.map((p, i) => (
        <Fragment key={p.mid}>
          {i > 0 && <ChevronRight size={11} className="shrink-0 text-faint" />}
          <button onClick={() => onSelect(p.mid)} className={cx("shrink-0 rounded px-1.5 py-px", i === path.length - 1 ? SELECTED : "hover:text-fg")}>
            {p.label}
          </button>
        </Fragment>
      ))}
      <span className="ml-auto truncate pl-3 font-sans text-faint">{hint}</span>
    </nav>
  );
}

/** "3 edits by hand · go with your next message". */
export function EditsChip({ text }: { text: string }) {
  return (
    <span aria-label="Edits by hand" className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-full bg-[rgba(91,156,255,0.12)] px-2.5 ui-text-12 text-[#8db8ff]">
      <Pencil size={11} className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** A message of the user's that carries edits by hand: the block of their
 *  lines, then what the user wrote. */
export function EditsMessage({ edits, text }: { edits: EditLineRead[]; text: string }) {
  return (
    <div className="flex justify-end py-1">
      <div className="flex max-w-[88%] flex-col gap-2 rounded-xl bg-raised px-3 py-2.5">
        <div aria-label="Edits by hand since your last turn" className="flex flex-col gap-0.5 rounded-lg bg-panel-2 px-2.5 py-2 font-mono ui-text-11.5 leading-normal text-muted">
          <span className="font-sans ui-text-11.5 text-fg">Edits by hand since your last turn:</span>
          {edits.map((e, i) => (
            <span key={i} className="selectable break-words">
              {lineRead(e)}
            </span>
          ))}
        </div>
        {text && <p className="selectable whitespace-pre-wrap break-words ui-text-13 text-fg">{text}</p>}
      </div>
    </div>
  );
}
