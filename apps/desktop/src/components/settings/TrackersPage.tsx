// Settings › Task trackers (X44): connections, Keep GitHub in step, branch
// names and sync. Saves to ~/.moonlet/trackers.toml as soon as a setting changes.

import { Lock, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/daemon";
import type { RuleSetting } from "../../lib/keepInStep";
import { M } from "../../lib/protocol";
import { errorToast, shownWorkspace, useStore } from "../../lib/store";
import { loadTrackersConfig, saveTrackersConfig, type TrackersConfig, trackersConfig, useTasks } from "../../lib/tasksStore";
import { GITHUB_RULES, githubConnection, RULE_SETTINGS as SETTINGS, SYNC_INTERVALS as INTERVALS } from "../../lib/trackersPage";
import { IconButton } from "../ui";
import { Card, fieldCls, PageHeading, Row, Section, Segmented, Status, SwitchRow } from "./controls";


const SOON = [
  { name: "Linear", note: "Sign in with your browser" },
  { name: "Jira Cloud", note: "API token" },
  { name: "ClickUp", note: "Personal API token" },
];

function RuleRow({ rule, value, onChange }: { rule: (typeof GITHUB_RULES)[number]; value: RuleSetting; onChange: (v: RuleSetting) => void }) {
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
  const save = (next: TrackersConfig) => void saveTrackersConfig(next).catch(errorToast);
  const github = config.github;
  const setGithub = (patch: Partial<TrackersConfig["github"]>) => save({ ...config, github: { ...github, ...patch } });
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
          {SOON.map((t) => (
            <Row key={t.name} label={t.name} hint={`${t.note} · coming in a later release`}>
              <span className="ui-text-12 text-faint">Not connected</span>
            </Row>
          ))}
        </Card>
      </Section>
      <Section title="Keep GitHub in step" hint="What moonlet does on GitHub when something happens in a session. Suggest shows the task as out of sync with a one-click fix instead.">
        <Card>
          {GITHUB_RULES.map((r) => (
            <RuleRow key={r.id} rule={r} value={github.rules[r.id]} onChange={(v) => setGithub({ rules: { ...github.rules, [r.id]: v } })} />
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
              defaultValue={github.branch_template}
              onBlur={(e) => e.target.value !== github.branch_template && setGithub({ branch_template: e.target.value.trim() })}
            />
          </Row>
          <Row label="Max length" htmlFor={maxId} setting="branch-max">
            <input
              id={maxId}
              className={`${fieldCls} w-[72px]`}
              inputMode="numeric"
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
      <Section title="Sync">
        <Card>
          <Row label="Refresh issues" hint="Also refreshes whenever the window comes to the front, at most every 15 s." htmlFor={intervalId} setting="sync-interval">
            <select id={intervalId} className={fieldCls} value={config.sync.interval} onChange={(e) => save({ ...config, sync: { ...config.sync, interval: Number(e.target.value) } })}>
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
            onChange={(notify) => save({ ...config, sync: { ...config.sync, notify } })}
          />
        </Card>
      </Section>
      <p className="flex items-center gap-2 ui-text-12 text-muted">
        <Lock size={13} /> Saved to ~/.moonlet/trackers.toml on this Mac. GitHub uses gh's own login; moonletd only stores which issue each session is linked to.
      </p>
    </>
  );
}
