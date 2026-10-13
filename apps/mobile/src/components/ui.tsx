// Small building blocks of the phone screens.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "@desktop/components/ui";
import moon from "../assets/moon.svg?raw";

export { AgentIcon, DiffStat, StateGlyph, cx } from "@desktop/components/ui";

type Tone = "primary" | "secondary" | "ghost";

/** A 44-point tall button, the design's three kinds. */
export function Btn({ tone = "secondary", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "flex h-11 items-center justify-center gap-1.5 rounded-[10px] px-3 text-[14.5px] disabled:opacity-40",
        tone === "primary" && "bg-fg font-semibold text-bg",
        tone === "secondary" && "border border-border-strong bg-raised text-fg",
        tone === "ghost" && "bg-transparent text-muted",
        className,
      )}
    />
  );
}

/** The design's switch: 44 × 26, clay when on. */
export function Switch({ on, onChange, label, children }: { on: boolean; onChange: (on: boolean) => void; label: string; children?: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className="flex min-h-[50px] w-full items-center gap-2.5 border-b border-border px-3.5 text-left last:border-b-0">
      {children}
      <span className="flex-1 text-[14.5px]">{label}</span>
      <span className={cx("relative h-[26px] w-[44px] flex-none rounded-full transition-colors", on ? "bg-accent" : "bg-border-strong")}>
        <span className={cx("absolute top-[3px] h-5 w-5 rounded-full bg-fg transition-all", on ? "left-[21px]" : "left-[3px]")} />
      </span>
    </button>
  );
}

/** A screen title at the top of a tab. */
export function Title({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pb-0" style={{ paddingTop: "calc(var(--safe-top) + 14px)" }}>
      <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">{children}</h1>
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** moonlet's ringed moon (src/assets/moon.svg), the desktop icon without its square. */
export function Moon({ size = 22 }: { size?: number }) {
  return <span aria-hidden="true" className="inline-block leading-none [&>svg]:h-full [&>svg]:w-full" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: moon }} />;
}
