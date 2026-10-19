// Settings › Git (X55): branches, worktrees and archiving, per host. Each
// host's daemon keeps its own, in `~/.moonlet/git.toml`.

import { useEffect, useId, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Folder, GitBranch } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { branchPreview, fetchOptions, gitHosts, gitSettingsOf, prefixError, tooOldText, worktreesFolder, worktreesText } from "../../lib/gitSettings";
import { M, type DaemonInfo, type GitSettings } from "../../lib/protocol";
import { errorToast, setGitSettings, useStore } from "../../lib/store";
import { Button, cx, selectCls } from "../ui";
import { Card, PageHeading, Row, Section, Segmented, SwitchRow, fieldCls, radioProps } from "./controls";

function HostSwitch({ host, onChange }: { host: string; onChange: (host: string) => void }) {
  const hosts = useStore((s) => s.hosts);
  const options = gitHosts(hosts);
  const id = useId();
  if (options.length < 2) return null;
  return (
    <>
      <span id={id} className="sr-only">
        Host
      </span>
      <Segmented value={options.some((o) => o.id === host) ? host : "local"} options={options} onChange={onChange} labelledBy={id} />
    </>
  );
}

const mono = (text: string) => <span className="font-mono">{text}</span>;

/** "Branch prefix": saved when the field is left or the page closes, if
 * git would take it. */
function PrefixRow({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (prefix: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const error = prefixError(text);
  const save = () => {
    if (!error && text !== value) onSave(text);
  };
  // Closing Settings unmounts the field without a blur.
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => () => latest.current(), []);
  return (
    <div data-setting="git-branch-prefix" className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4 px-4 py-3.5">
      <div className="flex flex-col gap-[3px] pt-[5px]">
        <label htmlFor="git-prefix" className="ui-text-13">
          Branch prefix
        </label>
        <span className="ui-text-12 text-muted">Put before the name of every new session's branch. Empty for none.</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <input
          id="git-prefix"
          className={cx(fieldCls, "font-mono ui-text-12.5")}
          spellCheck={false}
          disabled={disabled}
          value={text}
          aria-invalid={!!error}
          aria-describedby="git-prefix-preview"
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <span id="git-prefix-preview" className="flex min-w-0 items-center gap-1.5 font-mono ui-text-12 text-faint">
          <GitBranch size={12} className="shrink-0" />
          <span className="truncate">
            <span className="text-accent-2">{text}</span>
            {branchPreview("")}
          </span>
        </span>
        {error && <span className="ui-text-11.5 text-error">{error}</span>}
        <span className="ui-text-11.5 text-faint">
          Try {mono("marcin/")}, {mono("feat/")} or nothing. A project's {mono("branch_prefix")} wins over this.
        </span>
      </div>
    </div>
  );
}

const STARTS: { id: GitSettings["start_from"]; title: React.ReactNode; text: React.ReactNode }[] = [
  {
    id: "local",
    title: (
      <span className="flex items-center gap-2">
        <span className="font-mono ui-text-12.5 font-medium">main</span>
        <span className="ui-text-11.5 text-faint">default</span>
      </span>
    ),
    text: "The local branch as it is. Fast, works offline; may miss work merged since the last pull.",
  },
  {
    id: "origin",
    title: <span className="font-mono ui-text-12.5 font-medium">origin/main</span>,
    text: <>Fetches first, so every session starts from the latest merged work. Falls back to {mono("main")} when offline.</>,
  },
];

function StartRow({ value, disabled, onChange }: { value: GitSettings["start_from"]; disabled: boolean; onChange: (v: GitSettings["start_from"]) => void }) {
  const id = useId();
  const checked = STARTS.findIndex((x) => x.id === value);
  return (
    <div data-setting="git-start-from" className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex flex-col gap-[3px]">
        <span id={id} className="ui-text-13">
          Start new branches from
        </span>
        <span className="ui-text-12 text-muted">The project's base branch, {mono("main")} unless its settings say otherwise.</span>
      </div>
      <div role="radiogroup" aria-labelledby={id} className="grid grid-cols-2 gap-2">
        {STARTS.map((o, i) => (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            {...radioProps(i, checked, STARTS.length, (k) => onChange(STARTS[k].id))}
            className={cx("flex flex-col items-start gap-1.5 rounded-lg border px-3.5 py-3 text-left disabled:opacity-40", o.id === value ? "border-accent bg-selected" : "border-border bg-panel-2 hover:bg-hover")}
          >
            {o.title}
            <span className="ui-text-12 leading-[1.45] text-muted">{o.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the host's daemon puts worktrees; Reveal in Finder on This Mac. */
function WorktreesRow({ host }: { host: string }) {
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    void rpc<DaemonInfo>(host, M.daemonInfo).then(setInfo, () => {});
  }, [host]);
  const folder = info && worktreesFolder(info);
  return (
    <div data-setting="git-worktrees" className="flex items-center gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="ui-text-13">Worktrees folder</span>
        <span className="truncate font-mono ui-text-12 text-muted">{info && folder ? worktreesText(folder, info.home) : "…"}</span>
      </div>
      {host === "local" && folder && (
        <Button variant="ghost" size="sm" onClick={() => void revealItemInDir(folder).catch(errorToast)}>
          <Folder size={12} /> Reveal in Finder
        </Button>
      )}
    </div>
  );
}

const WORKTREE = [
  { id: "remove", label: "Remove" },
  { id: "keep", label: "Keep" },
] as const;

const BRANCH: { id: GitSettings["archive_branch"]; label: string; hint: string }[] = [
  { id: "ask", label: "Ask each time", hint: "The archive prompt asks with a checkbox." },
  { id: "keep", label: "Keep", hint: "The branch stays; unarchiving checks it out again." },
  { id: "merged", label: "Delete when its PR merged", hint: "Deleted when its PR merged on GitHub, kept otherwise." },
  { id: "always", label: "Always delete", hint: "Deleted with git branch -D, merged or not." },
];

export function GitPage() {
  const [picked, setPicked] = useState("local");
  const connected = useStore((s) => gitHosts(s.hosts).some((o) => o.id === picked));
  const host = connected ? picked : "local";
  const stored = useStore((s) => s.gitSettings[host]);
  const label = useStore((s) => (host === "local" ? "This Mac" : (s.hosts[host]?.label ?? host)));
  const g = gitSettingsOf({ [host]: stored }, host);
  const tooOld = stored === null;
  const set = (patch: Parameters<typeof setGitSettings>[1]) => void setGitSettings(host, patch);
  const fetchId = useId();
  const worktreeId = useId();
  return (
    <>
      <PageHeading title="Git" aside={<HostSwitch host={host} onChange={setPicked} />}>
        Branches, worktrees and archiving. Each host keeps its own, so sessions an agent opens follow them too.
      </PageHeading>
      {tooOld && <p className="m-0 rounded-md border border-[#4a3b17] bg-[#2a2210] px-3 py-2 ui-text-12.5 text-blocked">{tooOldText(label)}</p>}
      <Section title="New sessions">
        <Card>
          <PrefixRow value={g.branch_prefix} disabled={tooOld} onSave={(branch_prefix) => set({ branch_prefix })} />
          <StartRow value={g.start_from} disabled={tooOld} onChange={(start_from) => set({ start_from })} />
          <WorktreesRow host={host} />
        </Card>
      </Section>
      <Section title="Archiving a session">
        <Card>
          <Row setting="git-archive-worktree" label="Worktree folder" labelId={worktreeId} hint="Kept folders stay on disk; unarchiving reuses them.">
            <Segmented value={g.archive_worktree} options={WORKTREE} onChange={(v) => !tooOld && set({ archive_worktree: v })} labelledBy={worktreeId} />
          </Row>
          <Row setting="git-archive-branch" label="Local branch" htmlFor="git-archive-branch" hint={BRANCH.find((b) => b.id === g.archive_branch)?.hint}>
            <select id="git-archive-branch" className={cx(selectCls, "w-[220px] shrink-0")} disabled={tooOld} value={g.archive_branch} onChange={(e) => set({ archive_branch: e.target.value as GitSettings["archive_branch"] })}>
              {BRANCH.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </Row>
          <SwitchRow
            setting="git-delete-remote"
            label="Also delete the branch on origin"
            hint="Only when its PR merged. Skip if GitHub already deletes head branches for the repository."
            on={g.delete_remote_branch}
            disabled={tooOld}
            onChange={(on) => set({ delete_remote_branch: on })}
          />
        </Card>
      </Section>
      <Section title="Commits and pull requests">
        <Card>
          <SwitchRow setting="git-stage-all" label="Stage all changes before committing" hint="The Commit dialog's checkbox starts this way." on={g.stage_all} disabled={tooOld} onChange={(on) => set({ stage_all: on })} />
          <SwitchRow setting="git-draft-prs" label="Open pull requests as drafts" hint="Create pull request's Draft checkbox starts this way." on={g.draft_prs} disabled={tooOld} onChange={(on) => set({ draft_prs: on })} />
        </Card>
      </Section>
      <Section title="Keeping base branches current">
        <Card>
          <Row setting="git-fetch" label="Fetch from origin" labelId={fetchId} hint="For the ↓ chip next to a project. Also after a session's PR merges.">
            <Segmented value={String(g.fetch_minutes)} options={fetchOptions(g.fetch_minutes)} onChange={(v) => !tooOld && set({ fetch_minutes: Number(v) })} labelledBy={fetchId} />
          </Row>
          <SwitchRow
            setting="git-fast-forward"
            label="Fast-forward base branches automatically"
            hint={<>When {mono("main")} is only behind origin, pull it without a click. A diverged branch still waits for you.</>}
            on={g.fast_forward_base}
            disabled={tooOld}
            onChange={(on) => set({ fast_forward_base: on })}
          />
        </Card>
      </Section>
    </>
  );
}
