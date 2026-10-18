// A new issue from a board column's + (X52): title, description, assignee
// and labels; Create asks the tracker and the card opens on the board.

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { BoardColumn, BoardConfig } from "../../lib/boards";
import { canSubmit, type NewIssue as Draft, fitDraft, jiraProjectUrl, jiraProjects, needsPlace, needsType, newIssueDraft, projectRepos, withAccess } from "../../lib/newIssue";
import { trackerName } from "../../lib/tasks";
import { wsKey } from "../../lib/workspaces";
import { createIssue, createOptions, message, useTasks } from "../../lib/tasksStore";
import { Menu } from "../Menu";
import { Button, Dialog, inputCls, selectCls } from "../ui";

type Options = Awaited<ReturnType<typeof createOptions>>;

export function NewIssue({ host, workspaceId, board, column, onClose }: { host: string; workspaceId: string; board: BoardConfig; column: BoardColumn; onClose: () => void }) {
  // A GitHub Project's issue goes in a repository: the workspace's first, then those of the Project's items.
  const data = useTasks((t) => t.data[wsKey(host, workspaceId)]);
  // A GitHub Project's repository, or a Jira board's project.
  const keys = data?.boards?.[board.id]?.keys ?? [];
  const places = !needsPlace(board) ? [] : board.origin.kind === "github_project" ? projectRepos(data?.repos, data?.tasks ?? [], keys) : jiraProjects(data?.tasks ?? [], keys);
  const [chosen, setDraft] = useState<Draft>(() => newIssueDraft(board));
  // The repository picked, else the first, which can arrive after the form opens.
  const draft = { ...chosen, ...(!chosen.place && places[0] && { place: places[0] }) };
  // Jira's issue type: the one picked, else the project's first (Task when it has one).
  // Until the tracker's lists arrive, the user's own choices: assigned to them, the board's labels.
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [labelQuery, setLabelQuery] = useState("");
  useEffect(() => {
    let stale = false;
    setOptions(null);
    createOptions(host, board, draft.place, draft.issueType).then(
      (o) => {
        if (stale) return;
        setOptions(o);
        setDraft((d) => fitDraft(d, o.people.map((p) => p.id)));
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [host, board.id, board.connection, draft.place, draft.issueType]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const typed = { ...draft, ...(!draft.issueType && options?.issueTypes?.[0] && { issueType: options.issueTypes[0].id }) };
  const ready = canSubmit(typed, { busy, needsPlace: needsPlace(board), needsType: needsType(board), missing: options?.missing });
  const create = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    // Where gh's user can't set them, no assignee or labels are sent: GitHub would drop them.
    createIssue(host, workspaceId, board, column, withAccess(typed, options?.canSet ?? true).draft).then(onClose, (e) => {
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
        {needsPlace(board) && (board.origin.kind === "github_project" || places.length > 1) && (
          <label className="flex flex-col gap-1.5">
            <span className="ui-text-12 text-muted">{board.origin.kind === "github_project" ? "Repository" : "Project"}</span>
            <select className={selectCls} value={draft.place ?? ""} onChange={(e) => set({ place: e.target.value })}>
              {!places.length && <option value="">{board.origin.kind === "github_project" ? "No repository to create it in" : "No project to create it in"}</option>}
              {places.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
        {needsType(board) && (
          <label className="flex flex-col gap-1.5">
            <span className="ui-text-12 text-muted">Issue type</span>
            <select className={selectCls} value={typed.issueType ?? ""} onChange={(e) => set({ issueType: e.target.value })}>
              {(options?.issueTypes ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!!options?.missing?.length && (
          <p role="alert" className="ui-text-12.5 text-blocked">
            {trackerName(board.connection)} also requires {options.missing.join(", ")}; create it in {trackerName(board.connection)}.{" "}
            {draft.place && (
              <a href={jiraProjectUrl(board.connection, draft.place)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Open in Jira
              </a>
            )}
          </p>
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
