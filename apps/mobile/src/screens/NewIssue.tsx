// New issue in a column (X76, the desktop's X52 form): the Mac lists the
// people and labels and creates the issue in the tracker.

import { useEffect, useState } from "react";
import { fitDraft, isJira, newIssueDraft, type NewIssue } from "@desktop/lib/newIssue";
import { showScreen } from "../lib/app";
import type { PhoneBoard } from "../lib/board";
import { useBusy } from "../lib/busy";
import { askMac, createAction } from "../lib/taskActions";
import { type IssueOptions, issueForm } from "../lib/taskView";
import { Sheet } from "../components/Sheet";
import { Btn, cx } from "../components/ui";

function Picker({ label, value, options, onPick }: { label: string; value: string | undefined; options: { id: string; name: string }[]; onPick: (id: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[13px] text-muted">
      {label}
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value)} className="h-11 rounded-[10px] border border-border-strong bg-bg px-3 text-[15px] text-fg">
        {value === undefined && <option value="">Choose…</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NewIssueSheet({ b, column, onClose }: { b: PhoneBoard; column: string; onClose: () => void }) {
  const [draft, setDraft] = useState<NewIssue>(() => newIssueDraft(b.board));
  const [options, setOptions] = useState<IssueOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const { busy, error, run } = useBusy();
  const form = issueForm(b.board, b.snapshot, draft, options);
  const place = form.draft.place;
  useEffect(() => {
    let live = true;
    // The old place's lists no longer hold: Create waits for the new ones.
    setOptions(null);
    setOptionsError(null);
    askMac<IssueOptions>(b, { kind: "create_options", board: b.board.id, ...(place && { place }), ...(draft.issueType && { issue_type: draft.issueType }) }).then(
      (o) => {
        if (!live) return;
        setOptions(o);
        // Someone the new place does not have is not sent.
        setDraft((d) => fitDraft(d, o.people.map((p) => p.id)));
      },
      (e) => live && setOptionsError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
    // Again when another Mac serves the board: its lists are its own.
  }, [b.key, b.host, b.board.connection, place, draft.issueType]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<NewIssue>) => setDraft((d) => ({ ...d, ...patch }));
  const create = () =>
    run(async () => {
      const made = await askMac<{ task: string }>(b, createAction(b.board, column, form.draft));
      onClose();
      // Shown once the Mac shares it; until then the detail says so.
      showScreen({ kind: "task", board: b.key, task: made.task, created: true });
    });
  return (
    <Sheet label={`New issue in ${column}`} onClose={onClose}>
      <div className="scroll flex flex-col gap-3 px-4 pb-2">
        <div className="flex flex-col">
          <span className="text-[16px] font-semibold">New issue in {column}</span>
          <span className="text-[12.5px] text-muted">{b.board.name}</span>
        </div>
        <input autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Title" className="h-11 rounded-[10px] border border-border-strong bg-bg px-3 text-[15px] outline-none" />
        <textarea rows={4} value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Description (Markdown)" className="rounded-[10px] border border-border-strong bg-bg p-3 text-[14.5px] outline-none" />
        {form.askPlace && <Picker label={b.board.origin.kind === "github_project" ? "Repository" : "Project"} value={draft.place} options={form.places.map((p) => ({ id: p, name: p }))} onPick={(id) => set({ place: id, issueType: undefined })} />}
        {form.askType && options?.issueTypes && <Picker label="Issue type" value={draft.issueType} options={options.issueTypes} onPick={(id) => set({ issueType: id })} />}
        {form.assignee && (
          <Picker
            label="Assignee"
            value={draft.assignee}
            options={[{ id: "me", name: "Me" }, { id: "none", name: "Unassigned" }, ...(options?.people ?? []).filter((p) => p.id !== options?.me)]}
            onPick={(id) => set({ assignee: id })}
          />
        )}
        {form.labels && options && (options.labels.length > 0 || isJira(b.board)) && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted">Labels</span>
            <div className="flex flex-wrap gap-1.5">
              {[...options.labels, ...draft.labels.filter((x) => !options.labels.some((l) => l.id === x)).map((x) => ({ id: x, name: x }))].map((l) => {
                const on = draft.labels.includes(l.id);
                return (
                  <button key={l.id} type="button" onClick={() => set({ labels: on ? draft.labels.filter((x) => x !== l.id) : [...draft.labels, l.id] })} className={cx("h-8 rounded-full border px-3 text-[13px]", on ? "border-accent bg-selected" : "border-border-strong")}>
                    {l.name}
                  </button>
                );
              })}
            </div>
            {/* Jira takes a new label by its name (X52). */}
            {isJira(b.board) && (
              <input
                aria-label="Add a label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  const l = newLabel.trim();
                  if (e.key !== "Enter" || !l) return;
                  e.preventDefault();
                  if (!draft.labels.includes(l)) set({ labels: [...draft.labels, l] });
                  setNewLabel("");
                }}
                placeholder="Add a label"
                className="h-10 rounded-[10px] border border-border-strong bg-bg px-3 text-[14.5px] outline-none"
              />
            )}
          </div>
        )}
        {options?.missing?.length ? <span className="text-[12.5px] text-error">Jira needs {options.missing.join(", ")}: create this issue in Jira.</span> : null}
        {form.problem && <span className="text-[12.5px] text-error">{form.problem}</span>}
        {(error || optionsError) && <span className="text-[12.5px] text-error">{error ?? optionsError}</span>}
        {error === "moonlet on the Mac did not answer." && <span className="text-[12.5px] text-muted">The Mac may still create it: check the board before you try again.</span>}
        <Btn tone="primary" disabled={busy || !form.ready} onClick={() => void create()}>
          {busy ? "Creating…" : "Create"}
        </Btn>
      </div>
    </Sheet>
  );
}
