// A task's comments as the Comments section shows them (X66): pure, so the
// phone shows them the same way (X76).

import { ago } from "./mobile";
import { type Task, trackerName } from "./tasks";

export interface TaskComment {
  id: string;
  /** The tracker's display name; empty when it gives none. */
  author: string;
  body: string;
  /** Whether `body` is Markdown; ClickUp's is plain text. */
  markdown: boolean;
  createdMs: number;
}

/** One task's comments as loaded. */
export interface CommentsEntry {
  /** Oldest first; undefined until the first load ends. */
  comments?: TaskComment[];
  /** The tracker has more than these. */
  more: boolean;
  loading: boolean;
  /** Why the last load failed. */
  error: string | null;
  /** What the comments were loaded for: the task's updated time and where gh runs. */
  loadedFor?: string;
  /** What the load under way is for. */
  loadingFor?: string;
  /** A comment is being posted. */
  posting?: boolean;
  /** Why the last comment was refused; it stays in the box. */
  postError?: string | null;
  /** What the user is writing in the box, kept per task. */
  draft?: string;
}

/** Whether the box holds something to post. */
export const canPost = (text: string) => text.trim() !== "";

export interface CommentsView {
  heading: string;
  /** What shows instead of comments: loading, none, or a failed first load. */
  status: "loading" | "empty" | null;
  rows: (TaskComment & { ago: string })[];
  /** "More comments are in <tracker>", when it has more. */
  more: string | null;
}

/** What the Comments section shows. */
export function commentsView(e: CommentsEntry | undefined, task: Task, now: number): CommentsView {
  const comments = e?.comments ?? [];
  return {
    heading: `Comments ${comments.length}`,
    status: !e?.comments ? (e?.error ? null : "loading") : comments.length ? null : "empty",
    rows: comments.map((c) => ({ ...c, author: c.author || "Someone", ago: ago(Math.max(0, now - c.createdMs)) })),
    more: e?.more ? `More comments are in ${trackerName(task.connection)}` : null,
  };
}
