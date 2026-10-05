import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect } from "react";
import { GitBranch, SquareTerminal, X } from "lucide-react";
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
        size === "sm" ? "h-6 px-2 ui-text-12" : "h-7 px-2.5 ui-text-12.5",
        variant === "primary" && "bg-fg text-bg hover:bg-white",
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
  return <kbd className="rounded border border-border-strong bg-panel-2 px-1 font-sans ui-text-10.5 text-faint">{children}</kbd>;
}

export const STATE_LABEL: Record<AgentState, string> = {
  working: "Working",
  blocked: "Needs input",
  done: "Ready for review",
  error: "Failed",
  idle: "Idle",
};

/** PR state colour, GitHub's scheme: open green, merged purple, closed red. */
export function prTone(state: string | null | undefined): string {
  if (state === "merged") return "text-merged";
  if (state === "closed") return "text-error";
  if (state === "open") return "text-done";
  return "text-muted";
}

/** Sidebar/tab status: dots in the reference style, a branch for no agent. */
export function StateGlyph({ state, size = 13 }: { state: AgentState | null; size?: number }) {
  const box = { width: size, height: size };
  const dot = (cls: string, d = 7) => (
    <span className="inline-flex shrink-0 items-center justify-center" style={box}>
      <span className={cx("rounded-full", cls)} style={{ width: d, height: d }} />
    </span>
  );
  switch (state) {
    case "working":
      return (
        <span className="inline-flex shrink-0 items-center justify-center" style={box} aria-label="working">
          <span className="jaunt-dots">
            <i />
            <i />
            <i />
          </span>
        </span>
      );
    case "blocked":
      return dot("bg-blocked");
    case "done":
      return dot("bg-done");
    case "error":
      return dot("bg-error");
    case "idle":
      return dot("bg-idle", 5);
    default:
      return (
        <span className="inline-flex shrink-0 items-center justify-center text-muted" style={box}>
          <GitBranch size={size - 1} strokeWidth={1.75} />
        </span>
      );
  }
}

/** Agent brand marks for tabs and cards; terminals for everything else. */
export function AgentIcon({ agent, size = 14 }: { agent?: string | null; size?: number }) {
  const s = { width: size, height: size };
  switch (agent) {
    case "claude":
      return (
        <svg viewBox="0 0 24 24" style={s} className="shrink-0 text-accent" fill="currentColor" aria-label="Claude">
          {[0, 30, 60, 90, 120, 150].map((r) => (
            <rect key={r} x="11" y="2" width="2" height="20" rx="1" transform={`rotate(${r} 12 12)`} />
          ))}
        </svg>
      );
    case "codex":
      return (
        <svg viewBox="0 0 24 24" style={s} className="shrink-0 text-fg" fill="none" stroke="currentColor" strokeWidth="1.6" aria-label="Codex">
          {[0, 60, 120].map((r) => (
            <ellipse key={r} cx="12" cy="12" rx="9" ry="4.2" transform={`rotate(${r} 12 12)`} />
          ))}
        </svg>
      );
    case "cursor":
      return (
        <svg viewBox="0 0 24 24" style={s} className="shrink-0 text-fg" fill="currentColor" aria-label="Cursor">
          <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" opacity=".35" />
          <path d="M12 2 21 7l-9 5-9-5 9-5Z" />
        </svg>
      );
    case "opencode":
      return (
        <svg viewBox="0 0 24 24" style={s} className="shrink-0 text-fg" fill="none" stroke="currentColor" strokeWidth="2" aria-label="OpenCode">
          <rect x="4" y="3" width="16" height="18" rx="1" />
          <rect x="8" y="7" width="8" height="10" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return <SquareTerminal size={size} className="shrink-0 text-muted" strokeWidth={1.75} />;
  }
}

export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  if (!add && !del) return null;
  return (
    <span className={cx("font-mono ui-text-11 tabular-nums", className)}>
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
          <h2 className="ui-text-13 font-semibold">{title}</h2>
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
      <span className="mb-1 block ui-text-11.5 font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block ui-text-11 text-faint">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-border-strong bg-panel-2 px-2.5 py-1.5 ui-text-13 text-fg outline-none placeholder:text-faint focus:border-accent";

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
      {icon}
      <div className="ui-text-13 font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm ui-text-12">{children}</div>}
    </div>
  );
}
