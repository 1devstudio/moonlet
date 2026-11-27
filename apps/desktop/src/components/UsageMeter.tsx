import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClaudeUsage } from "../lib/claudeUsage";
import { shownWorkspace, useStore } from "../lib/store";
import { usageView, type UsageLevel } from "../lib/usageLimits";
import { IconButton, cx } from "./ui";

const WIDTH = 300;

const BAR: Record<UsageLevel, string> = { ok: "var(--color-accent)", warn: "var(--color-blocked)", error: "var(--color-error)" };
const TEXT: Record<UsageLevel, string> = { ok: "text-muted", warn: "text-blocked", error: "text-error" };

/**
 * The shown workspace's Claude usage limits in the sidebar footer (X115):
 * a ring and the current session's percentage at the right end of the
 * row, and a card with every limit and when it resets. Hidden while Claude
 * cannot say.
 */
export function UsageMeter() {
  const shown = useStore((s) => shownWorkspace(s));
  const { usage, refresh } = useClaudeUsage(shown?.host, shown?.id);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = rect !== null;
  useEffect(() => {
    // A passed reset and "Updated … ago" follow the clock.
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
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
  if (!usage || usage.limits.length === 0) return null;
  const view = usageView(usage, now);
  return (
    <>
      <button
        ref={anchor}
        title={view.title}
        aria-label={view.title}
        className={cx("flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-panel-2", open && "bg-panel-2")}
        onClick={() => {
          if (open) return setRect(null);
          setNow(Date.now());
          refresh();
          setRect(anchor.current?.getBoundingClientRect() ?? null);
        }}
      >
        <span className="grid h-3 w-3 place-items-center rounded-full" style={{ background: `conic-gradient(${BAR[view.ringLevel]} 0 ${view.ring}%, var(--color-border-strong) ${view.ring}% 100%)` }}>
          <span className="h-[7px] w-[7px] rounded-full bg-panel" />
        </span>
        <span className="whitespace-nowrap font-mono ui-text-11.5 text-faint">{view.footer}</span>
      </button>
      {rect &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="Usage limits"
            style={{ position: "fixed", width: WIDTH, left: Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8)), bottom: window.innerHeight - rect.top + 8 }}
            className="z-[60] flex flex-col gap-3 rounded-xl border border-border-strong bg-panel-2 px-4 py-3.5 shadow-2xl"
          >
            <div className="flex items-baseline justify-between">
              <span className="ui-text-13 font-medium text-fg">Usage limits</span>
              {view.plan && <span className="ui-text-12 text-muted">{view.plan}</span>}
            </div>
            {view.sections.map((s) => (
              <div key={s.heading} className="flex flex-col gap-2.5">
                <span className="ui-text-11 font-medium uppercase tracking-wide text-faint">{s.heading}</span>
                {s.rows.map((r) => (
                  <div key={r.label} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2 ui-text-12">
                      <span className="truncate text-fg">{r.label}</span>
                      {r.resets && <span className="shrink-0 whitespace-nowrap text-faint">{r.resets}</span>}
                    </div>
                    <div className="flex items-center gap-2.5">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-border-strong">
                        <div className="h-full rounded-[3px]" style={{ width: `${Math.min(100, r.percent)}%`, background: BAR[r.level] }} />
                      </div>
                      <span className={cx("w-9 shrink-0 text-right font-mono ui-text-12", TEXT[r.level])}>{r.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <div className="flex items-center justify-between gap-2 border-t border-border-strong pt-2">
              <span className="ui-text-11.5 text-faint">{view.updated}</span>
              <IconButton title="Refresh" className="-mr-1.5 h-6 w-6" onClick={refresh}>
                <RotateCw size={12} />
              </IconButton>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
