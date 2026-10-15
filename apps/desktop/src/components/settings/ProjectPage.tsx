// Settings › Projects › <name> (X8, X43): edits the project's
// `.moonlet/config.toml` through the daemon, which keeps the file's comments
// and unknown keys. Edits wait for Save in the bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, FileWarning, Folder, FolderOpen, Plus, RotateCw, Server, X } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { M, type ProjectConfigFile } from "../../lib/protocol";
import { errorToast, toast, useStore } from "../../lib/store";
import { agentOptions, configName, fromForm, isDirty, loadFailure, newRowId, saveBarStatus, toForm, validate, type AgentRow, type Form, type SaveError } from "../../lib/projectSettings";
import { tildePath } from "../../lib/profiles";
import { loadTrackersConfig, useTasks } from "../../lib/tasksStore";
import { projectTrackers } from "../../lib/trackerSources";
import { Button, IconButton, cx } from "../ui";
import { Card, PageBody, PageHeading, Row, SaveBar, Section, Status, fieldCls } from "./controls";
import { useUnsaved } from "./useUnsaved";

const EMPTY: Form = { setup: "", run: "", archive: "", default_agent: "", base_branch: "", agents: [], trackers: [] };

const input = (error?: string, width = "w-[300px]") => cx(fieldCls, "font-mono ui-text-12.5", width, !!error && "border-error focus:border-error");

const copyPath = (path: string) => path && void navigator.clipboard.writeText(path).then(() => toast("Copied path"));

function ProjectIcon() {
  return (
    <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-raised text-muted">
      <Folder size={20} />
    </span>
  );
}

export function ProjectPage({ host, id, focus }: { host: string; id: string; focus?: "run" }) {
  const project = useStore((s) => s.projects[host]?.find((p) => p.id === id));
  const remote = useStore((s) => (s.hosts[host]?.remote ? (s.hosts[host]?.label ?? host) : null));
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const [file, setFile] = useState<ProjectConfigFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [orig, setOrig] = useState<Form>(EMPTY);
  const [saveErr, setSaveErr] = useState<SaveError | null>(null);
  const [saving, setSaving] = useState(false);
  const runRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLInputElement>());
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  // The file's path, for a failed reload's message (`load` is memoised).
  const loadedPath = useRef<string | undefined>(undefined);
  const show = (f: ProjectConfigFile) => {
    loadedPath.current = f.path;
    const next = toForm(f.config);
    setFile(f);
    setForm(next);
    setOrig(next);
    setSaveErr(null);
    setLoadError(null);
  };

  const load = useCallback(
    async (reload = false) => {
      try {
        show(await rpc<ProjectConfigFile>(host, M.projectConfigFile, { id }));
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Nothing to edit yet: the page says why, with Check again. A
        // failed reload keeps the form and says so in the bar.
        const failure = loadFailure(reload, message, loadedPath.current);
        if (failure.close) setLoadError(message);
        else setSaveErr(failure.saveErr);
        return false;
      }
    },
    [host, id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void load();
  }, [load]);

  // After the first load has rendered: the fieldset is disabled until then,
  // and a disabled input can't take focus.
  const loaded = file !== null;
  useEffect(() => {
    if (loaded && focus === "run") runRef.current?.focus();
  }, [loaded, focus]);

  useEffect(() => {
    if (pendingFocus === null) return;
    rowRefs.current.get(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const loading = !file;
  const parseError = file?.error ?? null;
  const v = validate(form);
  const connections = useTasks((t) => t.config?.connections);
  useEffect(() => void loadTrackersConfig(), []);
  const trackers = projectTrackers(connections, form.trackers);
  const dirty = !parseError && isDirty(form, orig);
  const canSave = !loading && !parseError && dirty && !v.any && !saving;
  const path = file?.path ?? "";
  const name = configName(file?.path);

  const save = async () => {
    if (!canSave || !file) return;
    setSaving(true);
    try {
      show(await rpc<ProjectConfigFile>(host, M.projectSetConfig, { id, version: file.version, config: fromForm(form) }));
      toast(`Saved ${name}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stale = message.includes("config changed on disk");
      setSaveErr({ message: stale ? "The file changed on disk. Reload to see the new version." : message, stale });
    } finally {
      setSaving(false);
    }
  };
  useUnsaved({ dirty, saving, message: `Discard unsaved changes to ${name}?` }, () => void save());

  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaveErr((e) => (e?.stale ? e : null));
  };
  const setAgent = (rowId: number, patch: Partial<AgentRow>) => set({ agents: form.agents.map((a) => (a.id === rowId ? { ...a, ...patch, fresh: false } : a)) });
  const addAgent = () => {
    const rowId = newRowId();
    set({ agents: [...form.agents, { id: rowId, name: "", cmd: "", fresh: true }] });
    setPendingFocus(rowId);
  };

  const heading = (
    <PageHeading
      icon={<ProjectIcon />}
      title={
        <span className="flex items-center gap-2.5">
          {project?.name ?? "Project"}
          {remote && (
            <span className="inline-flex h-5 items-center gap-1 rounded bg-raised px-1.5 ui-text-11.5 font-normal text-muted">
              <Server size={11} />
              {remote}
            </span>
          )}
        </span>
      }
    >
      Edits <span className="font-mono text-fg">{name}</span>
      {remote ? ` on ${remote}.` : ", which is part of the repository. Comments and keys moonlet doesn't know are kept."}
    </PageHeading>
  );

  if (loadError)
    return (
      <PageBody>
        {heading}
        <Card>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <Status line={{ tone: "error", text: `Could not read ${name}: ${loadError}` }} />
            <Button className="self-start" onClick={() => void load()}>
              <RotateCw size={13} /> Check again
            </Button>
          </div>
        </Card>
      </PageBody>
    );

  if (parseError)
    return (
      <PageBody>
        {heading}
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-[#5a2a2e] bg-[#1c1213] p-4">
          <span className="flex items-center gap-2 ui-text-13 font-medium">
            <FileWarning size={16} className="text-error" />
            {name} is not valid TOML
          </span>
          <span className="ui-text-12.5 text-muted">Fix the file by hand, then check again. moonlet won't overwrite a file it can't read.</span>
          <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5 font-mono ui-text-12">
            <div className="whitespace-pre-wrap text-error">{parseError}</div>
            <div className="mt-1.5 break-all text-faint">{path}</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void load(true).then((ok) => ok && toast(`Reloaded ${name}`))}>
              <RotateCw size={13} /> Check again
            </Button>
            {remote ? (
              <Button variant="ghost" onClick={() => copyPath(path)}>
                <Copy size={13} /> Copy path
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void revealItemInDir(path).catch(errorToast)}>
                <FolderOpen size={13} /> Reveal in Finder
              </Button>
            )}
          </div>
        </div>
      </PageBody>
    );

  const status = saveBarStatus({ dirty, errors: v.count });

  return (
    <PageBody
      bar={
        <>
          {saveErr && (
            <div className="flex shrink-0 items-center gap-2 border-t border-[#5a2a2e] bg-[#2a1416] px-12 py-2 ui-text-12 text-error">
              <span className="mx-auto flex w-full max-w-[680px] items-center gap-2">
                <span className="min-w-0 flex-1">{saveErr.message}</span>
                {saveErr.stale && (
                  <Button size="sm" onClick={() => void load(true).then((ok) => ok && toast(`Reloaded ${name}`))}>
                    Reload
                  </Button>
                )}
              </span>
            </div>
          )}
          <SaveBar dirty={dirty} canSave={canSave} onDiscard={() => set({ ...orig })} onSave={() => void save()}>
            <button type="button" title="Copy path" className="truncate text-left font-mono ui-text-11.5 text-faint hover:text-muted" onClick={() => copyPath(path)}>
              {tildePath(path, home)}
            </button>
            <Status line={status} dot={status.tone !== "muted"} />
          </SaveBar>
        </>
      }
    >
      {heading}
      {file && !file.exists && (
        <p className="m-0 rounded-[10px] border border-border bg-panel px-4 py-3 ui-text-12.5 text-muted">
          No <span className="font-mono text-fg">.moonlet/config.toml</span> yet. Saving creates it.
        </p>
      )}
      <fieldset disabled={loading} className={cx("m-0 flex min-w-0 flex-col gap-8 border-0 p-0", loading && "opacity-50")}>
        <Section title="Scripts">
          <Card>
            <Row setting="project-setup" label="Setup" htmlFor="settings-p-setup" hint="Runs in a new session's worktree after it is created.">
              <input id="settings-p-setup" className={input()} spellCheck={false} value={form.setup} onChange={(e) => set({ setup: e.target.value })} placeholder="pnpm install" />
            </Row>
            <Row setting="project-run" label="Run" htmlFor="settings-p-run" hint="The Run button (⌘R). Running again restarts it.">
              <input id="settings-p-run" ref={runRef} className={input()} spellCheck={false} value={form.run} onChange={(e) => set({ run: e.target.value })} placeholder="pnpm dev" />
            </Row>
            <Row setting="project-archive" label="Archive" htmlFor="settings-p-archive" hint="Runs before a session is archived.">
              <input id="settings-p-archive" className={input()} spellCheck={false} value={form.archive} onChange={(e) => set({ archive: e.target.value })} placeholder="docker compose down" />
            </Row>
          </Card>
        </Section>

        <Section title="Agents">
          <Card>
            <Row setting="project-default-agent" label="Default agent" htmlFor="settings-p-default" hint={v.defaultAgent ? <span className="text-error">{v.defaultAgent}</span> : undefined}>
              <select id="settings-p-default" className={cx(fieldCls, "w-[240px]", v.defaultAgent && "border-error")} aria-invalid={!!v.defaultAgent} value={form.default_agent} onChange={(e) => set({ default_agent: e.target.value })}>
                {agentOptions(form).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <div data-setting="project-agents" className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex flex-col gap-[3px]">
                <span className="ui-text-13">Custom agents</span>
                <span className="ui-text-12 text-muted">Commands offered next to Claude and Codex when starting a session in this project.</span>
              </div>
              {form.agents.map((a) => {
                const e = v.agents[a.id] ?? {};
                const msg = [e.name, e.cmd].filter(Boolean).join(" ");
                return (
                  <div key={a.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={(el) => {
                          if (el) rowRefs.current.set(a.id, el);
                          else rowRefs.current.delete(a.id);
                        }}
                        className={input(e.name, "w-[150px] flex-none")}
                        aria-invalid={!!e.name}
                        spellCheck={false}
                        value={a.name}
                        onChange={(ev) => setAgent(a.id, { name: ev.target.value })}
                        placeholder="name"
                        aria-label="Agent name"
                      />
                      <input
                        className={input(e.cmd, "min-w-0 flex-1")}
                        aria-invalid={!!e.cmd}
                        spellCheck={false}
                        value={a.cmd}
                        onChange={(ev) => setAgent(a.id, { cmd: ev.target.value })}
                        placeholder="command"
                        aria-label="Agent command"
                      />
                      <IconButton title="Remove agent" onClick={() => set({ agents: form.agents.filter((x) => x.id !== a.id) })}>
                        <X size={14} />
                      </IconButton>
                    </div>
                    {msg && <span className="ui-text-12 text-error">{msg}</span>}
                  </div>
                );
              })}
              {form.agents.length === 0 && <span className="ui-text-12 text-faint">None. Claude and Codex are always available.</span>}
              <Button size="sm" className="self-start" onClick={addAgent}>
                <Plus size={12} /> Add agent
              </Button>
            </div>
          </Card>
        </Section>

        <Section title="Task trackers">
          <Card>
            <div data-setting="project-trackers" className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex flex-col gap-[3px]">
                <span className="ui-text-13">Tracker projects</span>
                <span className="ui-text-12 text-muted">A session started from an issue of these offers this project. With none linked, you pick from the workspace's projects.</span>
              </div>
              {trackers.linked.map((t) => (
                <div key={t.id} className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate ui-text-13">{t.label}</span>
                  <IconButton title={`Unlink ${t.label}`} onClick={() => set({ trackers: form.trackers.filter((x) => x !== t.id) })}>
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
              {trackers.linked.length === 0 && <span className="ui-text-12 text-faint">None linked.</span>}
              <select
                aria-label="Link a tracker project"
                className={cx(fieldCls, "w-[300px] self-start")}
                value=""
                disabled={!trackers.choices.length}
                onChange={(e) => e.target.value && set({ trackers: [...form.trackers, e.target.value] })}
              >
                <option value="">{trackers.choices.length ? "Link a tracker project…" : "No other sources: add them in Settings › Task trackers"}</option>
                {trackers.choices.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </Card>
        </Section>

        <Section title="Git">
          <Card>
            <Row setting="project-base" label="Base branch" htmlFor="settings-p-base" hint="New sessions branch from here, and Changes compare against it.">
              <input id="settings-p-base" className={input()} spellCheck={false} value={form.base_branch} onChange={(e) => set({ base_branch: e.target.value })} placeholder={file ? `Default: ${file.default_branch}` : ""} />
            </Row>
          </Card>
        </Section>
      </fieldset>
    </PageBody>
  );
}
