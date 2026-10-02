import { useRef } from "react";
import { cx } from "./ui";

/** Drag handle between two panels. Reports the pointer delta in pixels. */
export function Splitter({ dir, onDrag, onEnd }: { dir: "row" | "col"; onDrag: (delta: number) => void; onEnd?: () => void }) {
  const start = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      className={cx(
        "group relative z-10 shrink-0",
        dir === "row" ? "w-px cursor-col-resize bg-border" : "h-px cursor-row-resize bg-border",
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = dir === "row" ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        const pos = dir === "row" ? e.clientX : e.clientY;
        const delta = pos - start.current;
        if (delta !== 0) {
          start.current = pos;
          onDrag(delta);
        }
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        onEnd?.();
      }}
    >
      <div className={cx("absolute group-hover:bg-accent/40", dir === "row" ? "-left-1 -right-1 inset-y-0" : "-top-1 -bottom-1 inset-x-0")} />
    </div>
  );
}
