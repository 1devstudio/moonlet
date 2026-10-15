// Linear, Jira Cloud and ClickUp in Settings › Task trackers (X44): connect
// with a token, pick the sources each workspace shows, disconnect.

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { askConfirm } from "../../lib/confirm";
import { hostsApi } from "../../lib/daemon";
import { errorToast, useStore } from "../../lib/store";
import { type Connection, loadTrackersConfig, reconnected, saveTrackersConfig, type Source, useTasks } from "../../lib/tasksStore";
import { connectionLine } from "../../lib/trackersPage";
import { blankSource, changedStates, sourceChoices, sourceNoun, sourceRows, sourcesToSave } from "../../lib/trackerSources";
import type { Column } from "../../lib/tasks";
import { wsKey } from "../../lib/workspaces";
import { Button, Dialog, Field, IconButton, inputCls } from "../ui";
import { Row, Status } from "./controls";

const NAME: Record<Connection["kind"], string> = { linear: "Linear", jira: "Jira Cloud", clickup: "ClickUp" };
const TOKEN_PAGE: Record<Connection["kind"], string> = {
  linear: "https://linear.app/settings/account/security",
  jira: "https://id.atlassian.com/manage-profile/security/api-tokens",
  clickup: "https://app.clickup.com/settings/apps",
};

const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

/** Which sources a connection shows, in which workspace and starting in which project. */
function SourcesEditor({ connection, choices, onDone }: { connection: Connection; choices: { key: string; name: string }[]; onDone: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const [rows, setRows] = useState<Source[]>(() => sourceRows(connection.sources));
  const noun = sourceNoun(connection.kind);
  const wsOptions = Object.entries(workspaces).flatMap(([host, list]) => list.map((w) => ({ value: wsKey(host, w.id), label: w.name, host })));
  const set = (i: number, patch: Partial<Source>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const canAdd = !rows.some((r) => !r.key);
  const save = async () => {
    const sources = sourcesToSave(rows);
    try {
      await saveTrackersConfig((config) => ({ ...config, connections: (config.connections ?? []).map((c) => (c.id === connection.id ? { ...c, sources } : c)) }));
      onDone();
    } catch (e) {
      errorToast(message(e));
    }
  };
  const grid = "grid grid-cols-[minmax(0,1fr)_150px_150px_24px] items-center gap-2";
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-text-12.5 text-muted">
        Add the {noun}s whose issues Tasks mode shows. For each, pick the workspace that shows it and the moonlet project its sessions start in.
      </div>
      <div className={`${grid} ui-text-11.5 text-faint`} aria-hidden>
        <span>{noun}</span>
        <span>Workspace</span>
        <span>moonlet project</span>
      </div>
      <div role="list" aria-label="Sources" className="flex max-h-[300px] flex-col gap-1 overflow-y-auto">
        {rows.map((r, i) => {
          const host = r.workspace.split("/")[0];
          return (
            <div key={i} role="listitem" aria-label={r.name || "New source"} className={`${grid} ui-text-12.5`}>
              <select
                aria-label={`Source ${i + 1}`}
                className={inputCls}
                value={r.key}
                onChange={(e) => set(i, { key: e.target.value, name: choices.find((c) => c.key === e.target.value)?.name ?? "" })}
              >
                <option value="">{noun}…</option>
                {sourceChoices(choices, rows, i).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name} ({c.key})
                  </option>
                ))}
              </select>
              <select aria-label={`Workspace for ${r.name}`} className={inputCls} value={r.workspace} onChange={(e) => set(i, { workspace: e.target.value, project: "" })}>
                <option value="">Workspace…</option>
                {wsOptions.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
              <select aria-label={`Project for ${r.name}`} className={inputCls} value={r.project} disabled={!r.workspace} onChange={(e) => set(i, { project: e.target.value })}>
                <option value="">Project…</option>
                {(projects[host] ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <IconButton title={`Remove ${r.name || "this row"}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                <X size={14} />
              </IconButton>
            </div>
          );
        })}
      </div>
      <Button size="sm" className="self-start" disabled={!canAdd} onClick={() => setRows((rs) => [...rs, blankSource()])}>
        <Plus size={12} /> Add source
      </Button>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()}>
          Save and sync
        </Button>
      </div>
    </div>
  );
}

/** Connect (or reconnect) a tracker with a token, then pick its sources. */
export function ConnectTracker({ kind, reconnect, onClose }: { kind: Connection["kind"]; reconnect?: Connection; onClose: () => void }) {
  const [site, setSite] = useState(reconnect?.site ?? "");
  const [email, setEmail] = useState(reconnect?.email ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ connection: Connection; sources: { key: string; name: string }[] } | null>(null);
  const [oauth, setOauth] = useState(false);
  useEffect(() => {
    if (kind === "linear") hostsApi.trackerOauthAvailable().then(setOauth, () => setOauth(false));
  }, [kind]);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hostsApi.trackerOauthLinear();
      await loadTrackersConfig(true);
      reconnected(r.connection.id);
      setDone(r);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hostsApi.trackerConnect({ kind, site, email, token });
      await loadTrackersConfig(true);
      reconnected(r.connection.id);
      setDone(r);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`${reconnect ? "Reconnect" : "Connect"} ${NAME[kind]}`} onClose={onClose} width={done ? 680 : 560}>
      {done ? (
        <>
          <p className="mb-2 ui-text-12.5 text-done">
            Signed in as {done.connection.account} · {done.sources.length} {done.sources.length === 1 ? "source" : "sources"} visible
          </p>
          <SourcesEditor connection={done.connection} choices={done.sources} onDone={onClose} />
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {oauth && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void signIn()}>
                Sign in with Linear
              </Button>
              <p className="ui-text-12 text-muted">Opens the browser. Or use an API key:</p>
            </>
          )}
          {kind === "jira" && reconnect?.email && (
            <p className="ui-text-12.5 text-muted">
              {reconnect.site} as {reconnect.email}
            </p>
          )}
          {kind === "jira" && !reconnect?.email && (
            <>
              <Field label="Site">
                <input className={inputCls} placeholder="acme.atlassian.net" value={site} onChange={(e) => setSite(e.target.value)} />
              </Field>
              <Field label="Email">
                <input className={inputCls} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </>
          )}
          <Field
            label={kind === "linear" ? "API key" : "API token"}
            hint={
              <a href={TOKEN_PAGE[kind]} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Create one
              </a>
            }
          >
            <input className={inputCls} type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <p className="ui-text-12 text-muted">
            The token is saved in the macOS Keychain.{kind === "jira" ? " Tokens expire. moonlet tells you when Jira stops accepting it." : ""}
          </p>
          {error && <p className="ui-text-12.5 text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !token.trim()} onClick={() => void connect()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** One connection's row: its line, Sources, Reconnect when needed, Disconnect. */
export function ConnectionRow({ c }: { c: Connection }) {
  const attention = useTasks((t) => t.attention[c.id]);
  const [editing, setEditing] = useState<{ key: string; name: string }[] | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [statesOpen, setStatesOpen] = useState(false);
  const sources = async () => {
    try {
      setEditing(await hostsApi.trackerSources(c.id));
    } catch (e) {
      errorToast(message(e));
    }
  };
  const disconnect = async () => {
    const ok = await askConfirm({ title: `Disconnect ${NAME[c.kind]}?`, message: `moonlet forgets the token for ${c.site} and stops showing its issues. Sessions keep their links.`, action: "Disconnect", variant: "danger" });
    if (!ok) return;
    try {
      await hostsApi.trackerDisconnect(c.id);
      reconnected(c.id);
      await loadTrackersConfig(true);
    } catch (e) {
      errorToast(message(e));
    }
  };
  return (
    <>
      <Row label={`${NAME[c.kind]} · ${c.site}`} hint={<Status line={connectionLine(c, attention)} />} setting={`tracker-${c.id}`}>
        <div className="flex gap-1.5">
          {attention && (
            <Button size="sm" variant="primary" onClick={() => setReconnecting(true)}>
              Reconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void sources()}>
            Sources
          </Button>
          <Button size="sm" variant="ghost" disabled={!c.sources.length} onClick={() => setStatesOpen(true)}>
            States
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      </Row>
      {editing && (
        <Dialog title={`${NAME[c.kind]} sources`} onClose={() => setEditing(null)} width={680}>
          <SourcesEditor connection={c} choices={editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
      {reconnecting && <ConnectTracker kind={c.kind} reconnect={c} onClose={() => setReconnecting(false)} />}
      {statesOpen && <StatesEditor c={c} onClose={() => setStatesOpen(false)} />}
    </>
  );
}

/** "Add tracker": Linear, Jira Cloud or ClickUp. */
export function AddTracker() {
  const [kind, setKind] = useState<Connection["kind"] | null>(null);
  useEffect(() => void loadTrackersConfig(), []);
  return (
    <>
      <div className="flex gap-1.5">
        {(["linear", "jira", "clickup"] as const).map((k) => (
          <Button key={k} size="sm" variant="ghost" onClick={() => setKind(k)}>
            Connect {NAME[k]}
          </Button>
        ))}
      </div>
      {kind && <ConnectTracker kind={kind} onClose={() => setKind(null)} />}
    </>
  );
}

const COLUMN_CHOICES = [
  ["todo", "Todo"],
  ["in_progress", "In Progress"],
  ["in_review", "In Review"],
  ["done", "Done"],
  ["hidden", "Not shown"],
] as const;

/** Workflow states (X44): each state of a source and the column it lands in. */
export function StatesEditor({ c, onClose }: { c: Connection; onClose: () => void }) {
  const [source, setSource] = useState(c.sources[0]?.key ?? "");
  const [states, setStates] = useState<{ name: string; column: Column }[] | null>(null);
  const [mapping, setMapping] = useState<Record<string, Column>>(c.states ?? {});
  useEffect(() => {
    if (!source) return;
    setStates(null);
    hostsApi.trackerStates(c.id, source).then(setStates, (e) => errorToast(message(e)));
  }, [c.id, source]);
  const save = async () => {
    // Only states moved off their default column are kept.
    const kept = changedStates(states ?? [], mapping);
    try {
      await saveTrackersConfig((config) => ({ ...config, connections: (config.connections ?? []).map((x) => (x.id === c.id ? { ...x, states: kept as Connection["states"] } : x)) }));
      onClose();
    } catch (e) {
      errorToast(message(e));
    }
  };
  return (
    <Dialog title={`${NAME[c.kind]} workflow states`} onClose={onClose} width={520}>
      <p className="mb-2 ui-text-12.5 text-muted">moonlet groups tasks into four columns. Filled in from the tracker's state types; change them if your team uses its own.</p>
      {c.sources.length > 1 && (
        <select aria-label="Source" className={`${inputCls} mb-2`} value={source} onChange={(e) => setSource(e.target.value)}>
          {c.sources.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {!source && <p className="ui-text-12.5 text-muted">Pick a source first.</p>}
      {source && !states && <p className="ui-text-12.5 text-muted">Loading states…</p>}
      <div role="list" aria-label="States" className="flex flex-col gap-1">
        {(states ?? []).map((s) => (
          <div key={s.name} role="listitem" className="flex items-center gap-2 ui-text-12.5">
            <span className="min-w-0 flex-1 truncate text-fg">{s.name}</span>
            <select aria-label={`Column for ${s.name}`} className={`${inputCls} w-[140px]`} value={mapping[s.name] ?? s.column} onChange={(e) => setMapping((m) => ({ ...m, [s.name]: e.target.value as Column }))}>
              {COLUMN_CHOICES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="primary" disabled={!states} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
