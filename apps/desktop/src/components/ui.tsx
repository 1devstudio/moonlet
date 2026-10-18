import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect, useRef } from "react";
import { GitBranch, SquareTerminal, X } from "lucide-react";
import type { AgentState } from "../lib/protocol";
import { fromOtherDialog, tabWrap } from "../lib/modal";

import { cx } from "../lib/cx";
import { trackerOf } from "../lib/tasks";

export { cx };

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
          <span className="moonlet-dots">
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

/** Tracker brand marks (X44), from Simple Icons (CC0). Jira's blue is
 *  Atlassian's lighter one, which reads on the dark panels. */
const TRACKER_MARKS: Record<"linear" | "jira" | "clickup", { color: string; d: string }> = {
  linear: {
    color: "#5E6AD2",
    d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  },
  jira: {
    color: "#2684FF",
    d: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
  },
  clickup: {
    color: "#7B68EE",
    d: "M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z",
  },
};

export function TrackerIcon({ kind, size = 14 }: { kind: keyof typeof TRACKER_MARKS; size?: number }) {
  const m = TRACKER_MARKS[kind];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className="shrink-0" fill={m.color} aria-hidden="true">
      <path d={m.d} />
    </svg>
  );
}

/** A board's tracker mark: Linear, Jira and ClickUp's logos, GH for GitHub. */
export function BoardMark({ connection, size = 12 }: { connection: string; size?: 12 | 14 }) {
  const kind = trackerOf(connection);
  if (kind && kind !== "github") return <TrackerIcon kind={kind} size={size} />;
  return <span className={cx("shrink-0 text-center font-mono font-semibold", size === 12 ? "w-3 ui-text-9 text-muted" : "ui-text-10.5 text-fg")}>GH</span>;
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
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !fromOtherDialog(e, panel.current)) {
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
        ref={panel}
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

/**
 * The confirm modal (X23): a message, an optional option at the footer's
 * left, Cancel and the action. The action has focus, so Enter confirms; it
 * sits above any open Dialog and the toasts.
 */
export function ConfirmDialog({
  title,
  message,
  action,
  cancel = "Cancel",
  variant = "primary",
  checkbox,
  checked = false,
  onCheck,
  onConfirm,
  onCancel,
  wide = false,
  children,
}: {
  title: string;
  message: string;
  action: string;
  cancel?: string;
  variant?: "primary" | "danger";
  checkbox?: string;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 560 px instead of 440 px, for a preview of 80 columns (X31). */
  wide?: boolean;
  /** Shown under the message, such as the text an agent would read. */
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const ring = "focus:outline-2 focus:outline-offset-2 focus:outline-accent";
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(wide ? "w-[560px]" : "w-[440px]", "overflow-hidden rounded-xl border border-border-strong bg-panel shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] outline-none")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Tab stays inside, so it never reaches a dialog underneath.
          const to = e.key === "Tab" ? tabWrap(e.currentTarget, document.activeElement, e.shiftKey) : null;
          if (to) {
            e.preventDefault();
            to.focus();
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-border bg-panel-2 px-4 py-2.5">
          <h2 className="ui-text-13 font-semibold">{title}</h2>
          <IconButton title="Close" onClick={onCancel}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="p-4">
          <p className="whitespace-pre-line ui-text-12.5 leading-[1.55] text-pretty text-muted">{message}</p>
          {children}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-panel-2 px-4 py-2.5">
          {checkbox && (
            <label className="mr-auto flex items-center gap-1.5 ui-text-12 text-muted">
              <input type="checkbox" checked={checked} onChange={(e) => onCheck?.(e.target.checked)} />
              {checkbox}
            </label>
          )}
          <Button variant="ghost" className={ring} onClick={onCancel}>
            {cancel}
          </Button>
          <Button variant={variant} className={ring} autoFocus onClick={onConfirm}>
            {action}
          </Button>
        </div>
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

/** A native `<select>` styled as a field; WebKit ignores its height, so `menu-select` sets it. */
export const selectCls = cx(inputCls, "menu-select field-height");

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
      {icon}
      <div className="ui-text-13 font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm ui-text-12">{children}</div>}
    </div>
  );
}
