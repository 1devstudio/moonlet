// A task's comments (X66), in the Task detail and the Task tab.

import { ExternalLink } from "lucide-react";
import { useEffect, useMemo } from "react";
import { canPost, commentsView, ensureComments, loadComments, postComment, setDraft, useComments, type Where } from "../../lib/taskComments";
import type { Task } from "../../lib/tasks";
import { taskId } from "../../lib/tasks";
import { useStore } from "../../lib/store";
import { repoPath, useTasks } from "../../lib/tasksStore";
import { wsKey } from "../../lib/workspaces";
import { useNow } from "../../lib/useNow";
import { Markdown } from "../AgentView";
import { Button, inputCls, Kbd } from "../ui";

export function TaskComments({ host, workspaceId, task }: { host: string; workspaceId: string | null; task: Task }) {
  const entry = useComments((s) => s.byTask[taskId(task)]);
  const now = useNow(true);
  // A GitHub issue's gh runs in the project whose origin is its repository,
  // which may be known only after the task shows.
  const repos = useTasks((t) => (workspaceId ? t.data[wsKey(host, workspaceId)]?.repos : undefined));
  const projects = useStore((s) => s.projects[host]);
  const repo = task.github?.repo;
  const path = useMemo(() => (repo && workspaceId ? repoPath(host, workspaceId, repo) : null), [host, workspaceId, repo, repos, projects]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = (): Where => ({ host, path });
  useEffect(() => {
    void ensureComments(task, where());
    // Loaded again when the task changes in its tracker (its updated time) or its project shows up.
  }, [host, path, task.connection, task.key, task.updatedMs]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the user is writing, kept per task.
  const text = entry?.draft ?? "";
  const posting = !!entry?.posting;
  const post = () => void postComment(task, where());
  const view = commentsView(entry, task, now);
  return (
    <section aria-label="Comments">
      <div className="ui-text-11.5 font-medium text-faint">{view.heading}</div>
      {view.status === "loading" && <p className="mt-1 ui-text-12.5 text-muted">Loading comments…</p>}
      {view.status === "empty" && <p className="mt-1 ui-text-12.5 text-muted">No comments yet.</p>}
      {entry?.error && (
        <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-md border border-error/30 bg-error/[0.06] px-3 py-2 ui-text-12.5 text-error">
          <span className="min-w-0 flex-1">Couldn't load comments: {entry.error}</span>
          <Button size="sm" variant="ghost" onClick={() => void loadComments(task, where())}>
            Retry
          </Button>
        </div>
      )}
      <ol className="mt-1.5 flex flex-col gap-3">
        {view.rows.map((c) => (
          <li key={c.id} aria-label={`Comment by ${c.author}`} className="min-w-0">
            <div className="flex items-baseline gap-1.5 ui-text-12">
              <span className="font-medium text-fg">{c.author}</span>
              <span className="text-faint" title={new Date(c.createdMs).toLocaleString()}>
                · {c.ago}
              </span>
            </div>
            <div className="mt-0.5 ui-text-12.5">{c.markdown ? <Markdown text={c.body} task /> : <p className="whitespace-pre-wrap text-fg">{c.body}</p>}</div>
          </li>
        ))}
      </ol>
      {view.more && (
        <a href={task.url} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1 ui-text-12 text-muted hover:text-fg">
          {view.more} <ExternalLink size={12} />
        </a>
      )}
      <textarea
        rows={3}
        aria-label="New comment"
        placeholder="Leave a comment"
        className={`${inputCls} mt-3`}
        value={text}
        disabled={posting}
        onChange={(e) => setDraft(task, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !e.metaKey) return;
          e.preventDefault();
          post();
        }}
      />
      {entry?.postError && (
        <p role="alert" className="mt-1 ui-text-12 text-error">
          {entry.postError}
        </p>
      )}
      <div className="mt-1.5 flex justify-end">
        <Button size="sm" variant="primary" disabled={posting || !canPost(text)} onClick={post}>
          Comment <Kbd>⌘↵</Kbd>
        </Button>
      </div>
    </section>
  );
}
