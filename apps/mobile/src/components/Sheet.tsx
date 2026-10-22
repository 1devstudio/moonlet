import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** A bottom sheet over the screen; a tap outside closes it. It renders into
 * the body: iOS stacks a `.scroll` screen's fixed children inside it, which
 * left the tab bar over sheets opened from a tab. */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/55" onClick={onClose} aria-hidden="true" />
      <section role="dialog" aria-label={label} className="relative flex max-h-[88%] flex-col rounded-t-[22px] border-t border-border-strong bg-panel" style={{ paddingBottom: "max(var(--safe-bottom), 12px)" }}>
        <div className="flex justify-center pt-2 pb-1">
          <span className="h-[5px] w-9 rounded-full bg-border-strong" />
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
