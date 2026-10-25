// Building blocks of the settings page (X43): page heading, sections, cards
// of rows, switches, segmented controls and radio lists.

import { type KeyboardEvent, type ReactNode, useId } from "react";
import { radioKey, type StatusLine, type Tone } from "../../lib/settingsPage";
import { cx } from "../ui";

export const fieldCls =
  "h-[30px] rounded-md border border-border-strong bg-panel-2 px-2.5 ui-text-13 text-fg outline-none placeholder:text-faint focus:border-accent aria-[invalid=true]:border-error disabled:cursor-not-allowed disabled:opacity-40";

export function PageHeading({ title, children, aside, icon }: { title: ReactNode; children?: ReactNode; aside?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="m-0 ui-text-20 font-semibold tracking-[-0.01em]">{title}</h1>
        {children && <p className="m-0 ui-text-13 text-muted">{children}</p>}
      </div>
      {aside}
    </div>
  );
}

/** A titled group of settings; `hint` sits under the small-caps title. */
export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1 px-0.5">
        <h2 id={id} className="m-0 ui-text-11.5 font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </h2>
        {hint && <span className="ui-text-12 text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** Rows in a bordered card, divided by lines. */
export function Card({ children, className, danger }: { children: ReactNode; className?: string; danger?: boolean }) {
  return <div className={cx("flex flex-col rounded-[10px] border bg-panel [&>*+*]:border-t [&>*+*]:border-border", danger ? "border-[#3a2224]" : "border-border", className)}>{children}</div>;
}

/** A setting: label and hint on the left, its control on the right. */
export function Row({ label, hint, labelId, htmlFor, children, setting }: { label: ReactNode; hint?: ReactNode; labelId?: string; htmlFor?: string; children?: ReactNode; setting?: string }) {
  return (
    <div data-setting={setting} className="flex items-center gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className="ui-text-13">
            {label}
          </label>
        ) : (
          <span id={labelId} className="ui-text-13">
            {label}
          </span>
        )}
        {hint && <span className="ui-text-12 text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ on, onChange, labelledBy, disabled }: { on: boolean; onChange: (on: boolean) => void; labelledBy: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-[18px] w-8 shrink-0 rounded-[9px] transition-colors disabled:cursor-not-allowed disabled:opacity-40", on ? "bg-accent" : "bg-[#3a3a3a]")}
    >
      <span className={cx("absolute top-0.5 h-3.5 w-3.5 rounded-full transition-[left]", on ? "left-4 bg-white" : "left-0.5 bg-[#bdbdbd]")} />
    </button>
  );
}

/** A setting with a switch, labelled by its row. */
export function SwitchRow({ label, hint, on, onChange, disabled, setting }: { label: string; hint?: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; setting?: string }) {
  const id = useId();
  return (
    <Row label={label} hint={hint} labelId={id} setting={setting}>
      <Switch on={on} onChange={onChange} labelledBy={id} disabled={disabled} />
    </Row>
  );
}

/** Props for option `index` of a radio group whose checked option is
 * `checked`: one Tab stop, and arrow keys pick and focus the next option. */
export function radioProps(index: number, checked: number, count: number, pick: (index: number) => void) {
  return {
    role: "radio" as const,
    "aria-checked": index === checked,
    tabIndex: index === (checked < 0 ? 0 : checked) ? 0 : -1,
    onClick: () => pick(index),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const next = radioKey(e.key, index, count);
      if (next === null) return;
      e.preventDefault();
      pick(next);
      (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next] ?? null)?.focus();
    },
  };
}

export function Segmented<T extends string>({ value, options, onChange, labelledBy }: { value: T; options: readonly { id: T; label: string }[]; onChange: (v: T) => void; labelledBy: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex shrink-0 gap-0.5 rounded-[7px] border border-border bg-panel-2 p-0.5">
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          {...radioProps(
            i,
            options.findIndex((x) => x.id === value),
            options.length,
            (k) => onChange(options[k].id),
          )}
          className={cx("h-6 rounded-[5px] px-2.5 ui-text-12.5", o.id === value ? "bg-raised text-fg shadow-[0_0_0_1px_var(--color-border-strong)]" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A radio list in a card: one row per option, label and description. */
export function RadioList<T extends string>({ value, options, onChange, labelledBy }: { value: T; options: readonly { id: T; label: string; description: string }[]; onChange: (v: T) => void; labelledBy: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel [&>*+*]:border-t [&>*+*]:border-border">
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            {...radioProps(
              i,
              options.findIndex((x) => x.id === value),
              options.length,
              (k) => onChange(options[k].id),
            )}
            className={cx("flex w-full items-center gap-3 px-4 py-3 text-left", on ? "bg-selected" : "hover:bg-panel-2")}
          >
            <span className={cx("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]", on ? "border-accent" : "border-[#4a4a4a]")}>
              <span className={cx("h-1.5 w-1.5 rounded-full", on && "bg-accent")} />
            </span>
            <span className="w-[110px] shrink-0 ui-text-13">{o.label}</span>
            <span className="ui-text-12.5 text-muted">{o.description}</span>
          </button>
        );
      })}
    </div>
  );
}

const TONE_DOT: Record<Tone, string> = { done: "bg-done", accent: "bg-accent", blocked: "bg-blocked", error: "bg-error", muted: "bg-idle" };
const TONE_TEXT: Record<Tone, string> = { done: "text-muted", accent: "text-muted", blocked: "text-blocked", error: "text-error", muted: "text-muted" };

/** A status line with its coloured dot, and a path in mono after it. */
export function Status({ line, dot = true, className }: { line: StatusLine; dot?: boolean; className?: string }) {
  return (
    <span className={cx("flex min-w-0 items-center gap-1.5 ui-text-12", TONE_TEXT[line.tone], className)}>
      {dot && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[line.tone])} />}
      <span className="truncate">{line.text}</span>
      {line.path && (
        <>
          <span className="text-faint">·</span>
          <span className="truncate font-mono ui-text-11.5 text-faint">{line.path}</span>
        </>
      )}
    </span>
  );
}

/** A small rounded square with a letter, for profiles. */
export function Initial({ letter, className }: { letter: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised ui-text-13 font-semibold text-muted", className)}>
      {letter}
    </span>
  );
}

/** A page's scrolling column, with an optional bar pinned under it. */
export function PageBody({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
  return (
    <>
      <div data-settings-scroll className="min-h-0 flex-1 overflow-auto px-12 pb-16 pt-3">
        <div className="mx-auto flex max-w-[680px] flex-col gap-8">{children}</div>
      </div>
      {bar}
    </>
  );
}

/** The bar under a workspace or project page: what is unsaved, Discard and
 * Save (⌘↵). */
export function SaveBar({ children, onDiscard, onSave, canSave, dirty }: { children: ReactNode; onDiscard: () => void; onSave: () => void; canSave: boolean; dirty: boolean }) {
  return (
    <div role="region" aria-label="Unsaved changes" className="shrink-0 border-t border-border bg-panel px-12 py-2.5">
      <div className="mx-auto flex max-w-[680px] items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        {dirty && (
          <button type="button" onClick={onDiscard} className="h-7 rounded-md px-2.5 ui-text-12.5 text-muted hover:bg-hover hover:text-fg">
            Discard
          </button>
        )}
        <button
          type="button"
          disabled={!canSave}
          onClick={onSave}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-fg px-2.5 ui-text-12.5 font-medium text-bg hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save <span className="font-sans ui-text-11 opacity-60">⌘↵</span>
        </button>
      </div>
    </div>
  );
}
