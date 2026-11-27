// Claude usage limits in the sidebar footer (X115): what the footer and its
// card show of Claude Code's answer to `get_usage`.

import { ago } from "./mobile";
import type { ClaudeUsage, UsageLimit } from "./protocol";

export type UsageLevel = "ok" | "warn" | "error";

export interface UsageRow {
  label: string;
  /** For the bar: 0 once the limit has reset. */
  percent: number;
  /** "48%", or "—" once the limit has reset. */
  text: string;
  resets: string | null;
  level: UsageLevel;
}

export interface UsageView {
  /** "48%": the current session's. */
  footer: string;
  title: string;
  /** How full the footer's ring is, and its colour: the session's. */
  ring: number;
  ringLevel: UsageLevel;
  plan: string | null;
  updated: string;
  sections: { heading: string; rows: UsageRow[] }[];
}

const DAY = 86_400_000;

export function usageView(u: ClaudeUsage, now: number, locale?: string): UsageView {
  const rows = u.limits.map((l) => [l, row(l, now, locale)] as const);
  const find = (kind: string) => rows.find(([l]) => l.kind === kind)?.[1];
  const session = find("session");
  const week = find("weekly_all");
  // The current session's, else the first limit Claude reported.
  const footer = (session ?? rows[0]?.[1])?.text ?? "";
  const title = [session && `current session ${session.text}`, week && `weekly ${week.text}`].filter(Boolean).join(", ");
  const sections: UsageView["sections"] = [];
  for (const [l, r] of rows) {
    const heading = l.group === "session" ? "Session" : l.group === "weekly" ? "Weekly" : l.group;
    const last = sections[sections.length - 1];
    if (last?.heading === heading) last.rows.push(r);
    else sections.push({ heading, rows: [r] });
  }
  return {
    footer,
    title: `Claude usage: ${title || footer}`,
    ring: session?.percent ?? 0,
    ringLevel: session?.level ?? "ok",
    plan: u.plan ? u.plan[0].toUpperCase() + u.plan.slice(1) : null,
    updated: `Updated ${ago(Math.max(0, now - u.at))}`,
    sections,
  };
}

function row(l: UsageLimit, now: number, locale?: string): UsageRow {
  const label = l.kind === "session" ? "Current session" : l.kind === "weekly_all" ? "All models" : (l.model ?? l.kind);
  const resets = l.resets_at ? Date.parse(l.resets_at) : NaN;
  if (!Number.isNaN(resets) && resets <= now) {
    return { label, percent: 0, text: "—", resets: `Reset at ${when(resets, now, locale)}`, level: "ok" };
  }
  const level: UsageLevel = l.severity === "critical" || l.percent >= 100 ? "error" : l.severity === "warning" || l.percent >= 80 ? "warn" : "ok";
  return { label, percent: l.percent, text: `${l.percent}%`, resets: Number.isNaN(resets) ? null : `Resets ${when(resets, now, locale)}`, level };
}

/** "2:40 PM" today, "Wed 5:00 AM" within six days, "Dec 9" after that. */
function when(at: number, now: number, locale?: string): string {
  const midnight = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((midnight(at) - midnight(now)) / DAY);
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const opts: Intl.DateTimeFormatOptions = days === 0 ? time : Math.abs(days) < 7 ? { weekday: "short", ...time } : { month: "short", day: "numeric" };
  // Newer ICU puts a narrow no-break space before AM/PM.
  return new Date(at).toLocaleString(locale, opts).replace(/ /g, " ");
}
