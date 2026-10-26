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

/** Calls a backend command (Tauri's `invoke`). */
export type Send = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** Hands the verdict on job `id` to the backend; when the backend refuses it,
 *  hands it why instead, so the daemon hears the reason rather than a
 *  timeout. What fails is logged. */
export async function handBack(id: number, v: Verdict, send: Send, log: (message: string) => void): Promise<void> {
  try {
    await send("design_render_measured", { id, ...v });
    return;
  } catch (e) {
    log(`the render page could not hand back card ${id}: ${reason(e)}`);
    try {
      await send("design_render_measured", { id, error: `the render page could not hand back its verdict: ${reason(e)}` });
    } catch (again) {
      log(`the render page could not tell why either: ${reason(again)}`);
    }
  }
}

/** A failed command's message: Tauri rejects with the command's error. */
export function reason(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}
