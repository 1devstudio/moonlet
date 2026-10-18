// Settings › Task trackers (X44): connections, Keep GitHub in step, branch
// names and sync. Saves to ~/.moonlet/trackers.toml as soon as a setting changes.

import { Lock, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { hostsApi, rpc } from "../../lib/daemon";
import type { RuleSetting } from "../../lib/keepInStep";
import { M } from "../../lib/protocol";
import { errorToast, shownWorkspace, useStore } from "../../lib/store";
import { type BoardEntry, boardList } from "../../lib/trackerSources";
import { branchUser, loadTrackersConfig, openAddBoard, removeBoard, saveTrackersConfig, type TrackerSettings, type TrackersConfig, trackersConfig, trackerSettings, useTasks } from "../../lib/tasksStore";
import { GITHUB_RULES, githubConnection, previewTask, RULE_SETTINGS as SETTINGS, SYNC_INTERVALS as INTERVALS, trackerRules } from "../../lib/trackersPage";
import { AddTracker, ConnectionRow } from "./TrackerConnections";
import { BoardMark, Button, cx, IconButton } from "../ui";
import { Card, fieldCls, PageHeading, Row, Section, Segmented, Status, Switch, SwitchRow } from "./controls";
import { withPinned } from "../../lib/boards";
import { DEFAULT_LINK, type TrackerKind } from "../../lib/tasks";
import { parseWsKey, wsKey } from "../../lib/workspaces";


const NAME = { linear: "Linear", jira: "Jira", clickup: "ClickUp" } as const;

function RuleRow({ rule, value, onChange }: { rule: { id: string; when: string; then: string; hint: string; auto?: false }; value: RuleSetting; onChange: (v: RuleSetting) => void }) {
  const id = useId();
  return (
    <Row label={`${rule.when} → ${rule.then}`} hint={rule.hint} labelId={id} setting={`rule-${rule.id}`}>
      <Segmented value={value} options={rule.auto === false ? SETTINGS.filter((s) => s.id !== "auto") : SETTINGS} onChange={onChange} labelledBy={id} />
    </Row>
  );
}

export function TrackersPage() {
  const config = useTasks((t) => trackersConfig(t));
  const ws = useStore((s) => shownWorkspace(s));
  const hostLabel = useStore((s) => (ws ? (s.hosts[ws.host]?.label ?? ws.host) : "This Mac"));
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const check = () => {
    setLogin(undefined);
    void rpc<string>(ws?.host ?? "local", M.ghWhoami, {}).then(
      (l) => (setLogin(l), setError(null)),
      (e) => (setLogin(null), setError(e instanceof Error ? e.message : String(e))),
    );
  };
  useEffect(() => void loadTrackersConfig(), []);
  useEffect(check, [ws?.host]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (update: (c: TrackersConfig) => TrackersConfig) => void saveTrackersConfig(update).catch(errorToast);
  const github = config.github;
  const link = config.link ?? DEFAULT_LINK;
  const workspaces = useStore((s) => s.workspaces);
  const attention = useTasks((t) => t.attention);
  const wsRows = Object.entries(workspaces).flatMap(([host, list]) =>
    list.map((w) => {
      const key = wsKey(host, w.id);
      return { key, name: w.name, boards: boardList(key, config.boards, attention) };
    }),
  );
  const setGithub = (patch: Partial<TrackersConfig["github"]>) => save((c) => ({ ...c, github: { ...c.github, ...patch } }));
  const templateId = useId();
  const maxId = useId();
  const intervalId = useId();
  return (
    <>
      <PageHeading title="Task trackers">Connect your issue trackers so Tasks mode can show each issue beside the sessions, worktrees and pull requests working on it.</PageHeading>
      <Section title="Connections">
        <Card>
          <Row label="GitHub Issues" hint={<Status line={githubConnection(hostLabel, login, error)} />} setting="tracker-github">
            <IconButton title="Check again" onClick={check}>
              <RotateCw size={13} />
            </IconButton>
          </Row>
          {(config.connections ?? []).map((c) => (
            <ConnectionRow key={c.id} c={c} />
          ))}
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex flex-col gap-[3px]">
              <span className="ui-text-13">Add tracker</span>
              <span className="ui-text-12 text-muted">Linear and ClickUp with an API key or token; Jira Cloud with your email and an API token.</span>
            </div>
            <AddTracker />
          </div>
        </Card>
      </Section>
      {[...new Set((config.connections ?? []).map((c) => c.kind))].map((kind) => {
        const settings = trackerSettings(config, `${kind}:`);
        const setTracker = (patch: Partial<TrackerSettings>) => save((c) => ({ ...c, [kind]: { ...trackerSettings(c, `${kind}:`), ...patch } }));
        return (
          <Section key={kind} title={`Keep ${NAME[kind]} in step`} hint="Suggest shows the task as out of sync with a one-click fix instead.">
            <Card>
              {trackerRules(kind).map((r) => (
                <RuleRow key={r.id} rule={r} value={settings.rules[r.id]} onChange={(v) => save((c) => { const now = trackerSettings(c, `${kind}:`); return { ...c, [kind]: { ...now, rules: { ...now.rules, [r.id]: v } } }; })} />
              ))}
              <Row label="Branch name for new sessions" hint={<BranchPreview kind={kind} template={settings.branch_template} maxLen={settings.max_length} placeholders="{key}, {title}, {user}, {type} · empty: {key}-{title}" />} setting={`branch-template-${kind}`}>
                <input
                  aria-label={`Branch name for ${NAME[kind]} sessions`}
                  className={fieldCls}
                  placeholder="{key}-{title}"
                  // Keyed by the saved value: a file that loads after the page shows replaces the default.
                  key={settings.branch_template}
                  defaultValue={settings.branch_template}
                  onBlur={(e) => e.target.value.trim() !== settings.branch_template && setTracker({ branch_template: e.target.value.trim() })}
                />
              </Row>
            </Card>
          </Section>
        );
      })}
      <Section title="Keep GitHub in step" hint="What moonlet does on GitHub when something happens in a session. Suggest shows the task as out of sync with a one-click fix instead.">
        <Card>
          {GITHUB_RULES.map((r) => (
            <RuleRow key={r.id} rule={r} value={github.rules[r.id]} onChange={(v) => save((c) => ({ ...c, github: { ...c.github, rules: { ...c.github.rules, [r.id]: v } } }))} />
          ))}
        </Card>
      </Section>
      <Section title="Branch names" hint="The issue number in the branch name is what links a worktree to its issue, even one made outside moonlet.">
        <Card>
          <Row
            label="Branch name for new sessions"
            hint={<BranchPreview kind="github" template={github.branch_template} maxLen={github.max_length} placeholders="{number}, {title}, {key}, {user}, {type} · empty: {number}-{title}, as gh issue develop names it" />}
            htmlFor={templateId}
            setting="branch-template"
          >
            <input
              id={templateId}
              className={fieldCls}
              placeholder="{number}-{title}"
              key={github.branch_template}
              defaultValue={github.branch_template}
              onBlur={(e) => e.target.value !== github.branch_template && setGithub({ branch_template: e.target.value.trim() })}
            />
          </Row>
          <Row label="Max length" htmlFor={maxId} setting="branch-max">
            <input
              id={maxId}
              className={cx(fieldCls, "w-[72px]")}
              inputMode="numeric"
              key={github.max_length}
              defaultValue={github.max_length}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 8 && n <= 200 && n !== github.max_length) setGithub({ max_length: n });
                else e.target.value = String(github.max_length);
              }}
            />
          </Row>
        </Card>
      </Section>
      <Section title="Linking" hint="The issue key in the branch name is what links a worktree to its task, even one made outside moonlet.">
        <Card>
          <SwitchRow setting="link-branch" label="Link a session when its branch name contains the issue key" on={link.branch} onChange={(branch) => save((c) => ({ ...c, link: { ...(c.link ?? DEFAULT_LINK), branch } }))} />
          <SwitchRow setting="link-pr" label="Link a session when its pull request mentions the key or closes the issue" on={link.pr} onChange={(pr) => save((c) => ({ ...c, link: { ...(c.link ?? DEFAULT_LINK), pr } }))} />
          <SwitchRow
            setting="link-title"
            label="Suggest a task whose title is a session's name"
            hint="Only ever a suggestion: it never links by itself."
            on={link.title}
            onChange={(title) => save((c) => ({ ...c, link: { ...(c.link ?? DEFAULT_LINK), title } }))}
          />
        </Card>
      </Section>
      <div data-setting="boards">
        <Section title="Boards" hint="Tasks mode shows the boards of the workspace you are in; a pinned one is in its sidebar.">
          {wsRows.map((w) => {
            const { host, id } = parseWsKey(w.key);
            return (
              <Card key={w.key}>
                <Row label={w.name} hint={w.boards.length ? undefined : "No board yet"} setting={`ws-boards-${w.key}`}>
                  <Button size="sm" className="field-height" onClick={() => openAddBoard(host, id)}>
                    Add a board
                  </Button>
                </Row>
                {w.boards.map((x) => (
                  <BoardRow key={x.id} entry={x} onSettings={() => openAddBoard(host, id, { board: x.id })} onPin={(pinned) => save((c) => ({ ...c, boards: withPinned(c.boards ?? [], x.id, pinned) }))} />
                ))}
              </Card>
            );
          })}
        </Section>
      </div>
      <Section title="Sync">
        <Card>
          <Row label="Refresh issues" hint={config.sync.interval > 0 ? "Also refreshes whenever the window comes to the front, at most every 15 s." : "Refreshes when Tasks mode opens and when you press Refresh."} htmlFor={intervalId} setting="sync-interval">
            <select id={intervalId} className={fieldCls} value={config.sync.interval} onChange={(e) => { const interval = Number(e.target.value); save((c) => ({ ...c, sync: { ...c.sync, interval } })); }}>
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </Row>
          <SwitchRow
            setting="sync-notify"
            label="Notify when a task changes state outside moonlet"
            hint="For example, a reviewer reopens your issue. Only tasks with a session."
            on={config.sync.notify}
            onChange={(notify) => save((c) => ({ ...c, sync: { ...c.sync, notify } }))}
          />
        </Card>
      </Section>
      <p className="flex items-center gap-2 ui-text-12 text-muted">
        <Lock size={13} /> Tokens are kept in the macOS Keychain on this Mac and never sent to remote hosts. moonletd only stores which issue each session is linked to. Settings are saved to ~/.moonlet/trackers.toml.
      </p>
    </>
  );
}

/** The branch template's placeholders and what it makes of a real issue (X44 preview). */
function BranchPreview({ kind, template, maxLen, placeholders }: { kind: TrackerKind; template: string; maxLen: number; placeholders: string }) {
  const host = useStore((s) => shownWorkspace(s)?.host ?? "local");
  const connections = useTasks((t) => trackersConfig(t).connections);
  // The issue only, so a sync that changes nothing about it asks nothing again.
  const issue = useTasks(useShallow((t) => previewTask(Object.values(t.data).flatMap((d) => d.tasks), kind, connections ?? [])));
  const [example, setExample] = useState("");
  useEffect(() => {
    let live = true;
    void branchUser(host, issue.connection)
      .then((user) => hostsApi.taskBranch({ kind, key: issue.key, title: issue.title, number: issue.number, template: template || undefined, maxLen, user, issueType: issue.issueType }))
      .then((name) => live && setExample(name), () => live && setExample(""));
    return () => {
      live = false;
    };
  }, [issue.key, issue.title, issue.number, issue.issueType, issue.connection, kind, template, maxLen, host]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span>
      {placeholders}
      {example && (
        <>
          {" "}
          · e.g. <span className="font-mono">{example}</span>
        </>
      )}
    </span>
  );
}

/** One board in Settings › Task trackers › Boards (X50): its mark, name and origin, Pinned, Board settings and Remove. */
function BoardRow({ entry, onSettings, onPin }: { entry: BoardEntry; onSettings: () => void; onPin: (pinned: boolean) => void }) {
  const pinId = useId();
  return (
    <div role="group" aria-label={entry.name} data-setting={`board-${entry.id}`} className="flex items-center gap-3 border-t border-border px-4 py-2.5">
      <BoardMark connection={entry.connection} size={14} />
      <div className="min-w-0 flex-1">
        <div className="truncate ui-text-13 text-fg">{entry.name}</div>
        {/* A board whose connection needs attention says why, in red (X44). */}
        <div className={cx("truncate ui-text-12", entry.attention ? "text-error" : "text-faint")}>{entry.attention ?? entry.origin}</div>
      </div>
      <span id={pinId} className="ui-text-12 text-muted">
        Pinned
      </span>
      <Switch on={entry.pinned} onChange={onPin} labelledBy={pinId} />
      <Button size="sm" variant="ghost" className="field-height" onClick={onSettings}>
        Board settings
      </Button>
      <Button size="sm" variant="ghost" className="field-height" onClick={() => void removeBoard(entry).catch(errorToast)}>
        Remove
      </Button>
    </div>
  );
}
