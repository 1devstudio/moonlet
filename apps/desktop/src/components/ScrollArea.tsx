// A scrolling view (X94): its overscroll kept in, a 24 px fade on each edge
// with more to show, and, for a transcript, Latest once the end is far.

import { forwardRef, useCallback, useEffect, useRef, useState, type HTMLAttributes, type MutableRefObject } from "react";
import { ArrowDown } from "lucide-react";
import { scrollEdges } from "../lib/scrollEdges";
import { cx } from "./ui";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Classes of the wrapper, which holds the fades. */
  frame?: string;
  /** The tone the fades come from: a pane's, or the window's in a sidebar. */
  tone?: "pane" | "window";
  /** Offer Latest, which scrolls to the end, once it is more than 240 px away. */
  latest?: boolean;
  /** Scroll sideways too; otherwise long words wrap and nothing scrolls sideways. */
  x?: boolean;
};

const FADE = { pane: "from-bg", window: "from-window" } as const;

export const ScrollArea = forwardRef<HTMLDivElement, Props>(function ScrollArea({ frame, tone = "pane", latest = false, x = false, className, onScroll, children, ...rest }, ref) {
  const own = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ atTop: true, atBottom: true, far: false });
  const measure = useCallback(() => {
    const el = own.current;
    if (!el) return;
    const e = scrollEdges(el);
    setEdges((p) => (p.atTop === e.atTop && p.atBottom === e.atBottom && p.far === e.far ? p : e));
  }, []);
  // Measured again whenever the view or what it shows changes size.
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    const mo = new MutationObserver(() => {
      for (const c of Array.from(el.children)) ro.observe(c);
      measure();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);
  const setRef = (el: HTMLDivElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as MutableRefObject<HTMLDivElement | null>).current = el;
  };
  return (
    <div className={cx("relative flex min-h-0 flex-1 flex-col", frame)}>
      <div
        ref={setRef}
        {...rest}
        className={cx("min-h-0 flex-1 overflow-y-auto overscroll-contain [scroll-padding-top:24px]", x ? "overflow-x-auto" : "overflow-x-hidden [overflow-wrap:anywhere]", className)}
        onScroll={(e) => {
          measure();
          onScroll?.(e);
        }}
      >
        {children}
      </div>
      {!edges.atTop && <span aria-hidden="true" data-fade="top" className={cx("pointer-events-none absolute left-0 right-3 top-0 h-6 bg-gradient-to-b from-20% to-transparent", FADE[tone])} />}
      {!edges.atBottom && <span aria-hidden="true" data-fade="bottom" className={cx("pointer-events-none absolute bottom-0 left-0 right-3 h-6 bg-gradient-to-t from-20% to-transparent", FADE[tone])} />}
      {latest && edges.far && (
        <button
          className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-raised pl-2.5 pr-3 ui-text-12 text-fg/85 shadow-[0_6px_18px_rgba(0,0,0,0.45)] hover:bg-hover hover:text-fg"
          onClick={() => own.current?.scrollTo({ top: own.current.scrollHeight, behavior: "smooth" })}
        >
          <ArrowDown size={12} /> Latest
        </button>
      )}
    </div>
  );
});
