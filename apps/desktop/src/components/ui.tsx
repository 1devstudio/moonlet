import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect } from "react";
import { AlertTriangle, Check, CircleDashed, LoaderCircle, X } from "lucide-react";
import type { AgentState } from "../lib/protocol";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "ghost" | "subtle" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }>(
  ({ variant = "subtle", size = "md", className, ...rest }, ref) => (
    <button
      ref={ref}
      className={cx(
        "no-drag inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
        variant === "primary" && "bg-accent text-[#0b0c0e] hover:bg-[#93adff]",
        variant === "subtle" && "border border-border-strong bg-raised text-fg hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        variant === "danger" && "border border-[#5a2a2e] bg-[#2a1416] text-error hover:bg-[#3a1b1e]",
        className,
      )}
      {...rest}
    />
  ),
);

export function IconButton({ title, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      className={cx(
        "no-drag inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
        className,
      )}
      {...rest}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-panel-2 px-1 font-sans text-[10.5px] text-faint">{children}</kbd>;
}

export const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  blocked: "Needs input",
  done: "Ready for review",
  error: "Failed",
  idle: "Idle",
};

export function StateGlyph({ state, size = 13 }: { state: AgentState | null; size?: number }) {
  switch (state) {
    case "working":
      return <LoaderCircle size={size} className="spin text-working" aria-label="working" />;
    case "blocked":
      return <AlertTriangle size={size} className="pulse text-blocked" aria-label="needs input" />;
    case "done":
      return <Check size={size} className="text-done" aria-label="done" />;
    case "error":
      return <X size={size} className="text-error" aria-label="failed" />;
    case "idle":
      return <CircleDashed size={size} className="text-idle" aria-label="idle" />;
    default:
      return <span className="inline-block h-1.5 w-1.5 rounded-full bg-border-strong" style={{ margin: (size - 6) / 2 }} />;
  }
}

export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  if (!add && !del) return null;
  return (
    <span className={cx("font-mono text-[11px] tabular-nums", className)}>
      <span className="text-add">+{add}</span> <span className="text-del">−{del}</span>
    </span>
  );
}

export function Dialog({ title, onClose, children, width = 480, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[76vh] overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <IconButton title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="max-h-[60vh] overflow-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-border-strong bg-panel-2 px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent";

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
      {icon}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm text-[12px]">{children}</div>}
    </div>
  );
}
