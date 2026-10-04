// Project settings dialog (X8): edits the project's `.jaunt/config.toml`
// through the daemon, which keeps the file's comments and unknown keys.

import { useCallback, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileWarning, FolderOpen, Plus, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type ProjectConfigFile } from "../lib/protocol";
import { errorToast, toast, useStore } from "../lib/store";
import { agentOptions, fromForm, isDirty, loadFailure, newRowId, toForm, validate, type AgentRow, type Form, type SaveError } from "../lib/projectSettings";
import { Button, IconButton, cx } from "./ui";

const close = () => useStore.setState({ dialog: null });

/** One width and one border colour per field: two conflicting utilities
 *  (`w-full` and `w-[150px]`) resolve by CSS order, not by class order. */
const fieldCls = (error?: unknown, width = "w-full") =>
  cx(
    "rounded-md border bg-panel-2 px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint",
    width,
    error ? "border-error focus:border-error" : "border-border-strong focus:border-accent",
  );

const EMPTY: Form = { setup: "", run: "", archive: "", default_agent: "", base_branch: "", agents: [] };

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block last:mb-0">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export function ProjectSettingsDialog({ host, project: projectId, focus }: { host: string; project: string; focus?: "run" }) {
  const project = useStore((s) => s.projects[host]?.find((p) => p.id === projectId));
  const hostLabel = useStore((s) => s.hosts[host]?.label ?? host);
  const [file, setFile] = useState<ProjectConfigFile | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [orig, setOrig] = useState<Form>(EMPTY);
  const [confirming, setConfirming] = useState(false);
  const [saveErr, setSaveErr] = useState<SaveError | null>(null);
  const [saving, setSaving] = useState(false);
  const runRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLInputElement>());
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  const load = useCallback(async (reload = false) => {
    try {
      const f = await rpc<ProjectConfigFile>(host, M.projectConfigFile, { id: projectId });
      const next = toForm(f.config);
      setFile(f);
      setForm(next);
      setOrig(next);
      setSaveErr(null);
      return true;
    } catch (e) {
      const failure = loadFailure(reload, e instanceof Error ? e.message : String(e));
      if (failure.close) {
        errorToast(e);
        close();
      } else setSaveErr(failure.saveErr);
      return false;
    }
  }, [host, projectId]);

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
  const dirty = isDirty(form, orig);
  const canSave = !loading && !parseError && dirty && !v.any && !saving;
  const remote = host !== "local";

  const requestClose = useCallback(() => {
    if (parseError || !dirty) close();
    else setConfirming(true);
  }, [parseError, dirty]);

  const save = useCallback(async () => {
    if (!canSave || !file) return;
    setSaving(true);
    try {
      await rpc<ProjectConfigFile>(host, M.projectSetConfig, { id: projectId, version: file.version, config: fromForm(form) });
      toast("Saved .jaunt/config.toml");
      close();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stale = message.includes("config changed on disk");
      setSaveErr({ message: stale ? "The file changed on disk. Reload to see the new version." : message, stale });
    } finally {
      setSaving(false);
    }
  }, [canSave, file, host, projectId, form]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (confirming) setConfirming(false);
        else requestClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirming, requestClose, save]);

  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaveErr((e) => (e?.stale ? e : null));
    setConfirming(false);
  };
  const setAgent = (id: number, patch: Partial<AgentRow>) =>
    set({ agents: form.agents.map((a) => (a.id === id ? { ...a, ...patch, fresh: false } : a)) });
  const addAgent = () => {
    const id = newRowId();
    set({ agents: [...form.agents, { id, name: "", cmd: "", fresh: true }] });
    setPendingFocus(id);
  };

  const subtitle = [project?.name, remote ? hostLabel : null].filter(Boolean).join(" · ");
  const path = file?.path ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={requestClose}>
      <div
        role="dialog"
        aria-label="Project settings"
        className="flex max-h-[76vh] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        style={{ width: "min(560px, 90vw)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="text-[13px] font-semibold">Project settings</h2>
            <span className="truncate text-[12px] text-muted">{subtitle}</span>
          </div>
          <IconButton title="Close" onClick={requestClose}>
            <X size={14} />
          </IconButton>
        </div>

        {parseError ? (
          <div className="overflow-auto p-4">
            <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
              <FileWarning size={22} className="text-error" />
              <div className="text-[13px] font-medium text-fg">.jaunt/config.toml is not valid TOML</div>
              <div className="max-w-sm text-[12px] text-muted">Fix the file by hand, then open Project settings again. jaunt won't overwrite a file it can't read.</div>
            </div>
            <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5 font-mono text-[12px]">
              <div className="whitespace-pre-wrap text-error">{parseError}</div>
              <div className="mt-1 break-all text-faint">{path}</div>
            </div>
            {!remote && (
              <div className="mt-3 flex justify-center">
                <Button onClick={() => void revealItemInDir(path).catch(errorToast)}>
                  <FolderOpen size={13} /> Reveal in Finder
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {file && !file.exists && (
              <p className="mb-4 rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12px] text-muted">
                No <span className="font-mono text-fg">.jaunt/config.toml</span> yet. Saving creates it.
              </p>
            )}
            <fieldset disabled={loading} className={cx("m-0 min-w-0 border-0 p-0", loading && "opacity-50")}>
              <section className="mb-5">
                <h3 className="mb-2 text-[12px] font-semibold">Scripts</h3>
                <Labeled label="Setup" hint="Runs in a new session's worktree after it is created.">
                  <input className={fieldCls()} spellCheck={false} value={form.setup} onChange={(e) => set({ setup: e.target.value })} placeholder="pnpm install" />
                </Labeled>
                <Labeled label="Run" hint="The Run button (⌘R). Running again restarts it.">
                  <input ref={runRef} className={fieldCls()} spellCheck={false} value={form.run} onChange={(e) => set({ run: e.target.value })} placeholder="pnpm dev" />
                </Labeled>
                <Labeled label="Archive" hint="Runs before a session is archived.">
                  <input className={fieldCls()} spellCheck={false} value={form.archive} onChange={(e) => set({ archive: e.target.value })} placeholder="docker compose down" />
                </Labeled>
              </section>

              <section className="mb-5">
                <h3 className="mb-2 text-[12px] font-semibold">Agents</h3>
                <label className="mb-3 block">
                  <span className="mb-1 block text-[11.5px] font-medium text-muted">Default agent</span>
                  <select
                    className={cx(fieldCls(v.defaultAgent), "font-sans text-[13px]")}
                    value={form.default_agent}
                    onChange={(e) => set({ default_agent: e.target.value })}
                  >
                    {agentOptions(form).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {v.defaultAgent && <span className="mt-1 block text-[11px] text-error">{v.defaultAgent}</span>}
                </label>
                <div className="mb-1 text-[11.5px] font-medium text-muted">Custom agents</div>
                <div className="flex flex-col gap-1.5">
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
                            className={fieldCls(e.name, "w-[150px] flex-none")}
                            spellCheck={false}
                            value={a.name}
                            onChange={(ev) => setAgent(a.id, { name: ev.target.value })}
                            placeholder="name"
                            aria-label="Agent name"
                          />
                          <input
                            className={fieldCls(e.cmd, "min-w-0 flex-1")}
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
                        {msg && <span className="text-[11px] text-error">{msg}</span>}
                      </div>
                    );
                  })}
                </div>
                {form.agents.length === 0 && <div className="text-[12px] text-faint">None. Claude and Codex are always available.</div>}
                <div className="mt-2">
                  <Button size="sm" onClick={addAgent}>
                    <Plus size={12} /> Add agent
                  </Button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-[12px] font-semibold">Git</h3>
                <Labeled label="Base branch" hint="New sessions branch from here, and Changes compare against it.">
                  <input
                    className={fieldCls()}
                    spellCheck={false}
                    value={form.base_branch}
                    onChange={(e) => set({ base_branch: e.target.value })}
                    placeholder={file ? `Default: ${file.default_branch}` : ""}
                  />
                </Labeled>
              </section>
            </fieldset>
          </div>
        )}

        {saveErr && (
          <div className="flex items-center gap-2 border-t border-[#5a2a2e] bg-[#2a1416] px-4 py-2 text-[12px] text-error">
            <span className="min-w-0 flex-1">{saveErr.message}</span>
            {saveErr.stale && (
              <Button size="sm" onClick={() => void load(true).then((ok) => ok && toast("Reloaded .jaunt/config.toml"))}>
                Reload
              </Button>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <div className="mr-auto flex min-w-0 flex-col">
            <button
              className="truncate text-left font-mono text-[11px] text-faint hover:text-muted"
              title="Copy path"
              onClick={() => path && void navigator.clipboard.writeText(path).then(() => toast("Copied path"))}
            >
              {path}
            </button>
            <span className="text-[11px] text-faint">This file is part of the repository.</span>
          </div>
          {parseError ? (
            <Button onClick={close}>Close</Button>
          ) : confirming ? (
            <>
              <span className="text-[12px] text-muted">Discard unsaved changes?</span>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={close}>
                Discard
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={requestClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
                Save <span className="rounded border border-current px-1 font-sans text-[10.5px] opacity-60">⌘↵</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
