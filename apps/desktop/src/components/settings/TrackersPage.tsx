// Settings › Task trackers (X44): connections, Keep GitHub in step, branch
// names and sync. Saves to ~/.moonlet/trackers.toml as soon as a setting changes.

import { Lock, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/daemon";
import type { RuleSetting } from "../../lib/keepInStep";
import { M } from "../../lib/protocol";
import { errorToast, shownWorkspace, useStore } from "../../lib/store";
import { loadTrackersConfig, saveTrackersConfig, type TrackerSettings, type TrackersConfig, trackersConfig, trackerSettings, useTasks } from "../../lib/tasksStore";
import { GITHUB_RULES, githubConnection, RULE_SETTINGS as SETTINGS, SYNC_INTERVALS as INTERVALS, trackerRules } from "../../lib/trackersPage";
import { AddTracker, ConnectionRow } from "./TrackerConnections";
import { IconButton } from "../ui";
import { Card, fieldCls, PageHeading, Row, Section, Segmented, Status, SwitchRow } from "./controls";
import { DEFAULT_LINK } from "../../lib/tasks";
import { wsKey } from "../../lib/workspaces";


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
  const data = useTasks((t) => t.data);
  const wsRows = Object.entries(workspaces).flatMap(([host, list]) =>
    list.map((w) => {
      const key = wsKey(host, w.id);
      const NAMES = { linear: "Linear", jira: "Jira", clickup: "ClickUp" } as const;
      const repos = (data[key]?.sources ?? []).filter((x) => !x.includes(":")).map((r) => `GitHub ${r}`);
      const others = (config.connections ?? []).flatMap((c) => c.sources.filter((s) => s.workspace === key).map((s) => `${NAMES[c.kind]} ${s.name}`));
      return { key, name: w.name, sources: [...repos, ...others] };
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
          <Row label="Add tracker" hint="Linear and ClickUp with an API key or token; Jira Cloud with your email and an API token.">
            <AddTracker />
          </Row>
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
              <Row label="Branch name for new sessions" hint="{key}, {title} · empty: {key}-{title}" setting={`branch-template-${kind}`}>
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
          <Row label="Branch name for new sessions" hint="{number}, {title}, {key} · empty: {number}-{title}, as gh issue develop names it" htmlFor={templateId} setting="branch-template">
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
              className={`${fieldCls} w-[72px]`}
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
      <Section title="Where each workspace gets its tasks" hint="Tasks mode shows the sources of the workspace you are in.">
        <Card>
          {wsRows.map((w) => (
            <Row key={w.key} label={w.name} hint={w.sources.length ? w.sources.join(" · ") : "No source: a project with a GitHub origin, or a team, project or list picked under Sources"} setting={`ws-sources-${w.key}`} />
          ))}
        </Card>
      </Section>
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
