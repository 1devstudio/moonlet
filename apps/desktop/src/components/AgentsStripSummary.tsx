import type { StripView } from "../lib/subagents";
import { AGENT_STATE } from "../lib/subagents";
import { cx } from "./ui";

/** The agents strip's dots and words (X42): a dot per agent, then "All
 *  done", the counts and what needs the user. Shared by the desktop and the
 *  phone (X40), which size the row around it. */
export function AgentsStripSummary({ view }: { view: StripView }) {
  return (
    <>
      <span role="img" aria-label={view.label} className="-mr-1 flex shrink-0 items-center">
        {view.dots.map((d) => (
          <span key={d.key} className={cx("agents-dot", AGENT_STATE[d.state].dot, d.state === "running" && "pulse", d.phase !== "on" && d.phase)} />
        ))}
      </span>
      <span className="min-w-0 truncate text-muted">
        {view.finished ? (
          <span className="agents-fade-in inline-flex items-center gap-2 text-fg">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="agents-check shrink-0 text-done">
              <path d="M3 7.4 5.8 10 11 4" />
            </svg>
            {view.title}
          </span>
        ) : null}
        {view.counts.map((c) => (
          <span key={c.state} className={cx(c.state === "done" && "agents-done-count", c.state === "done" && view.flash && "text-done")}>
            {`${c.lead ? "" : " · "}${c.text}`}
          </span>
        ))}
        {view.alert && (
          <span className={cx("agents-fade-in", view.alert.tone === "blocked" ? "text-blocked" : "text-error")}>
            {`${view.alert.lead ? "" : " · "}${view.alert.text}`}
          </span>
        )}
      </span>
    </>
  );
}
