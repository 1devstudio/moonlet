// A new issue from a board column's + (X52): title, description, assignee
// and labels; Create asks the tracker and the card opens on the board.

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { BoardColumn, BoardConfig } from "../../lib/boards";
import { canSubmit, type NewIssue as Draft, needsPlace, newIssueDraft, projectRepos, withAccess } from "../../lib/newIssue";
import { taskId } from "../../lib/tasks";
import { wsKey } from "../../lib/workspaces";
import { createIssue, createOptions, message, useTasks } from "../../lib/tasksStore";
import { Menu } from "../Menu";
import { Button, Dialog, inputCls, selectCls } from "../ui";

type Options = Awaited<ReturnType<typeof createOptions>>;

export function NewIssue({ host, workspaceId, board, column, onClose }: { host: string; workspaceId: string; board: BoardConfig; column: BoardColumn; onClose: () => void }) {
  // A GitHub Project's issue goes in a repository: the workspace's first, then those of the Project's items.
  const data = useTasks((t) => t.data[wsKey(host, workspaceId)]);
  const places = needsPlace(board)
    ? projectRepos(
        Object.values(data?.repos ?? {}).filter((r): r is string => !!r),
        (data?.tasks ?? []).filter((t) => data?.boards?.[board.id]?.keys.includes(taskId(t))),
      )
    : [];
  const [draft, setDraft] = useState<Draft>(() => ({ ...newIssueDraft(board), ...(places[0] && { place: places[0] }) }));
  // Until the tracker's lists arrive, the user's own choices: assigned to them, the board's labels.
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [labelQuery, setLabelQuery] = useState("");
  useEffect(() => {
    let stale = false;
    setOptions(null);
    createOptions(host, board, draft.place).then(
      (o) => {
        if (stale) return;
        setOptions(o);
        setDraft((d) => withAccess(d, o.canSet).draft);
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [host, board.id, board.connection, draft.place]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const ready = canSubmit(draft, { busy, needsPlace: needsPlace(board) });
  const create = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    createIssue(host, workspaceId, board, column, draft).then(onClose, (e) => {
      setBusy(false);
      setError(message(e));
    });
  };
  const people = (options?.people ?? []).filter((p) => p.id !== options?.me);
  const assigneeName = draft.assignee === "me" ? "Me" : draft.assignee === "none" ? "Unassigned" : (people.find((p) => p.id === draft.assignee)?.name ?? draft.assignee);
  const labels = [...new Set([...draft.labels, ...(options?.labels ?? []).map((l) => l.name)])];
  const has = (name: string) => draft.labels.some((l) => l.toLowerCase() === name.toLowerCase());
  return (
    <Dialog
      title={`New issue in ${column.name}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            create();
          }
        }}
      >
        <p className="-mt-1 ui-text-12 text-faint">{board.name}</p>
        {needsPlace(board) && (
          <label className="flex flex-col gap-1.5">
            <span className="ui-text-12 text-muted">Repository</span>
            <select className={selectCls} value={draft.place ?? ""} onChange={(e) => set({ place: e.target.value })}>
              {!places.length && <option value="">No repository to create it in</option>}
              {places.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="ui-text-12 text-muted">Title</span>
          <input autoFocus className={inputCls} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="ui-text-12 text-muted">Description</span>
          <textarea rows={5} placeholder="Markdown" className={inputCls} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        {withAccess(draft, options?.canSet ?? true).assignment && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="ui-text-12 text-muted">Assignee</span>
              <Menu
                width={240}
                search={{ placeholder: "Find a person", query: peopleQuery, onQuery: setPeopleQuery }}
                items={[
                  { label: "Me", checked: draft.assignee === "me", onSelect: () => set({ assignee: "me" }) },
                  { label: "Unassigned", checked: draft.assignee === "none", onSelect: () => set({ assignee: "none" }) },
                  ...people
                    .filter((p) => p.name.toLowerCase().includes(peopleQuery.toLowerCase()))
                    .map((p) => ({ label: p.name, checked: draft.assignee === p.id, onSelect: () => set({ assignee: p.id }) })),
                ]}
                trigger={(open) => (
                  <button aria-label="Assignee" onClick={open} className={`${inputCls} flex items-center justify-between text-left`}>
                    {assigneeName}
                    <ChevronDown size={12} className="text-faint" />
                  </button>
                )}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="ui-text-12 text-muted">Labels</span>
              <Menu
                width={240}
                search={{ placeholder: "Find a label", query: labelQuery, onQuery: setLabelQuery }}
                items={labels
                  .filter((l) => l.toLowerCase().includes(labelQuery.toLowerCase()))
                  .map((l) => ({ label: l, checked: has(l), onSelect: () => set({ labels: has(l) ? draft.labels.filter((x) => x.toLowerCase() !== l.toLowerCase()) : [...draft.labels, l] }) }))}
                trigger={(open) => (
                  <button aria-label="Labels" onClick={open} className={`${inputCls} flex items-center justify-between text-left`}>
                    <span className="truncate">{draft.labels.length ? draft.labels.join(", ") : "None"}</span>
                    <ChevronDown size={12} className="text-faint" />
                  </button>
                )}
              />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="ui-text-12.5 text-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
