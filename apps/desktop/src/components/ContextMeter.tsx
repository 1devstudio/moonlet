import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { contextView } from "../lib/chat";
import type { ContextUsage } from "../lib/protocol";
import { Button, cx } from "./ui";

const WIDTH = 320;

/**
 * The context ring in the chat footer (X34): how full the agent's context
 * window is, and a card with the breakdown and Compact now. A compact chat
 * shows the ring without its percentage (X51).
 */
export function ContextMeter({ usage, onCompact, showPercent = true }: { usage: ContextUsage; onCompact: () => void; showPercent?: boolean }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = rect !== null;
  const view = contextView(usage);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setRect(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) setRect(null);
    };
    const onResize = () => setRect(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  return (
    <>
      <button
        ref={anchor}
        title="Context window"
        aria-label={`Context window, ${view.percent}% used`}
        className={cx("flex h-[26px] items-center gap-1.5 rounded-md px-1.5 hover:bg-hover", open && "bg-hover")}
        onClick={() => setRect((r) => (r ? null : (anchor.current?.getBoundingClientRect() ?? null)))}
      >
        <span
          className="grid h-3.5 w-3.5 place-items-center rounded-full"
          style={{ background: `conic-gradient(var(--color-accent) 0 ${view.percent}%, var(--color-border-strong) ${view.percent}% 100%)` }}
        >
          <span className="h-2 w-2 rounded-full bg-bg" />
        </span>
        {showPercent && <span className="font-mono ui-text-12.5 text-muted">{view.percent}%</span>}
      </button>
      {rect &&
        createPortal(
          <div
            ref={panel}
            style={{ position: "fixed", width: WIDTH, left: Math.min(rect.left, window.innerWidth - WIDTH - 8), bottom: window.innerHeight - rect.top + 8 }}
            className="z-[60] flex flex-col gap-3 rounded-xl border border-border-strong bg-panel-2 px-4 py-3.5 shadow-2xl"
          >
            <div className="flex items-baseline justify-between">
              <span className="ui-text-13 font-medium text-fg">Context window</span>
              <span className="shrink-0 whitespace-nowrap font-mono ui-text-12 text-muted">{view.label}</span>
            </div>
            <div className="flex h-1.5 gap-px overflow-hidden rounded-[3px] bg-border-strong">
              {view.rows.map((r) => (
                <span key={r.name} style={{ width: `${r.width}%`, background: r.color }} />
              ))}
            </div>
            <div className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 ui-text-12 text-muted">
              {view.rows.map((r) => (
                <Row key={r.name} swatch={<span className="h-2 w-2 rounded-[2px]" style={{ background: r.color }} />} name={r.name} tokens={r.tokens} />
              ))}
              <Row swatch={<span className="h-2 w-2 rounded-[2px] border border-faint bg-border-strong" />} name="Free" tokens={view.free} />
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border-strong pt-2.5">
              <span className="whitespace-nowrap ui-text-11.5 text-faint">{view.autoCompact}</span>
              <Button
                size="sm"
                onClick={() => {
                  setRect(null);
                  onCompact();
                }}
              >
                Compact now
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Row({ swatch, name, tokens }: { swatch: React.ReactNode; name: string; tokens: string }) {
  return (
    <>
      {swatch}
      <span className="truncate">{name}</span>
      <span className="font-mono">{tokens}</span>
    </>
  );
}
