// The app's hidden render page (X64): which URL it frames for a job from the
// daemon, and which message from the frame answers it.

import { cardUrl } from "./designView";
import { readMeasurements, rubric } from "./renderRubric";

/** A card to render, as the app's backend hands it to the page. */
export interface RenderJob {
  id: number;
  workspace: string;
  /** The design system. */
  slug: string;
  /** The card's path in the system: `components/…`. */
  path: string;
  viewport: [number, number];
  /** The snippet shown alone, by its full id. */
  variant: string | null;
}

/** The page's answer: the rubric's flags and the page errors, or why there are none. */
export type Verdict = { metrics: { flags: string[]; errors: string[] } } | { error: string };

/** The card's URL on the `moonlet-design://` scheme, asking for the measuring script. */
export function renderUrl(job: RenderJob): string {
  const variant = job.variant ? `&variant=${encodeURIComponent(job.variant)}` : "";
  return `${cardUrl(job.workspace, job.slug, job.path)}?moonlet-render=${job.id}${variant}`;
}

/** The verdict a message from the card's frame gives on job `job`; null when it is not about it. */
export function verdict(data: unknown, job: number): Verdict | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { type?: unknown; job?: unknown; metrics?: unknown; errors?: unknown };
  if (d.type !== "moonlet-render" || String(d.job) !== String(job)) return null;
  const m = readMeasurements(d.metrics);
  if (!m) {
    const why = Array.isArray(d.errors) ? d.errors.filter((e) => typeof e === "string").join("; ") : "";
    return { error: `the card could not be measured${why ? `: ${why}` : ""}` };
  }
  return { metrics: { flags: rubric(m), errors: m.errors } };
}
