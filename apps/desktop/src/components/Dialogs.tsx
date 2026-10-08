import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { askConfirm } from "../lib/confirm";
import { CheckCircle2, Play, Server, Trash2 } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type Commit, type HookStatus, type PullRequest, type Project } from "../lib/protocol";
import { errorToast, refreshGit, selectedSession, toast, updateSettings, useStore } from "../lib/store";
import { Button, Dialog, Field, cx, inputCls } from "./ui";
import { Composer } from "./Composer";
import { ProjectSettingsDialog } from "./ProjectSettings";
import { CLAUDE_MODES, PLAN_APPROVE_MODES, resolveMode, resolvePlanMode } from "../lib/agents";
import type { ToolCallView } from "../lib/chat";
import { DEFAULT_SOUNDS, SOUND_EVENTS, SYSTEM_SOUNDS, soundFor } from "../lib/sounds";
import { EDITOR_THEMES, resolveEditorTheme } from "../lib/editorThemes";

const close = () => useStore.setState({ dialog: null });

export function AddProjectDialog({ host: presetHost, workspace: presetWorkspace }: { host?: string; workspace?: string }) {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const [host, setHost] = useState(presetHost ?? "local");
  const [wsId, setWsId] = useState(presetWorkspace ?? workspaces[presetHost ?? "local"]?.[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = Object.values(hosts).filter((h) => h.status === "connected");
  const hostWorkspaces = workspaces[host] ?? [];
  const add = async () => {
    setBusy(true);
    try {
      const project = wsId
        ? await rpc<Project>(host, M.workspaceAddProject, { id: wsId, path })
        : await rpc<Project>(host, M.projectAdd, { path });
      toast(`Added ${project.name}`);
      useStore.setState({ dialog: { kind: "new-session", host, project: project.id, workspace: wsId || undefined } });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add project"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!path || busy} onClick={() => void add()}>
            Add project
          </Button>
        </>
      }
    >
      <p className="mb-3 ui-text-12.5 text-muted">A project is a git repository folder. Each session you start in it gets its own worktree and branch.</p>
      {connected.length > 1 && (
        <Field label="Host">
          <select
            className={inputCls}
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setWsId(workspaces[e.target.value]?.[0]?.id ?? "");
            }}
          >
            {connected.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Folder" hint={host === "local" ? "Any folder inside a git repository." : "Path on the remote host, e.g. ~/src/api"}>
        <div className="flex gap-2">
          <input autoFocus className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-project" onKeyDown={(e) => e.key === "Enter" && path && void add()} />
          {host === "local" && (
            <Button
              onClick={async () => {
                const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project folder" });
                if (typeof dir === "string") setPath(dir);
              }}
            >
              Browse…
            </Button>
          )}
        </div>
      </Field>
      {hostWorkspaces.length > 0 && (
        <Field label="Workspace">
          <select className={inputCls} value={wsId} onChange={(e) => setWsId(e.target.value)}>
            {hostWorkspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Dialog>
  );
}

export function NewWorkspaceDialog() {
  const hosts = useStore((s) => s.hosts);
  const [name, setName] = useState("");
  const connected = Object.values(hosts).filter((h) => h.status === "connected");
  const [host, setHost] = useState(() => (connected.some((h) => h.id === "local") ? "local" : (connected[0]?.id ?? "local")));
  const create = async () => {
    try {
      await rpc(host, M.workspaceCreate, { name });
      close();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Dialog
      title="New workspace"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <p className="mb-3 ui-text-12.5 text-muted">A workspace is a set of projects shown together in the sidebar, e.g. "Work" or "Personal".</p>
      <Field label="Name">
        <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" onKeyDown={(e) => e.key === "Enter" && name.trim() && void create()} />
      </Field>
      {connected.length > 1 && (
        <Field label="Host">
          <select className={inputCls} value={host} onChange={(e) => setHost(e.target.value)}>
            {connected.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Dialog>
  );
}

export function CommitDialog() {
  const s = useStore.getState();
  const ws = selectedSession(s);
  const host = s.selected?.host ?? "local";
  const [message, setMessage] = useState("");
  const [all, setAll] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!ws) return null;
  const commit = async () => {
    setBusy(true);
    try {
      const sha = await rpc<string>(host, M.gitCommit, { path: ws.path, message, all });
      toast(`Committed ${sha.slice(0, 7)}`);
      void refreshGit(host, ws.id);
      close();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Commit changes"
      onClose={close}
      footer={
        <>
          <label className="mr-auto flex items-center gap-1.5 ui-text-12 text-muted">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Stage all changes first
          </label>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!message.trim() || busy} onClick={() => void commit()}>
            Commit
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        className={cx(inputCls, "min-h-[110px] font-mono ui-text-12.5")}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="feat: describe the change"
        onKeyDown={(e) => e.key === "Enter" && e.metaKey && void commit()}
      />
    </Dialog>
  );
}

export function CreatePrDialog() {
  const s = useStore.getState();
  const ws = selectedSession(s);
  const host = s.selected?.host ?? "local";
  const [title, setTitle] = useState(ws?.name ?? "");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ws) return;
    void rpc<Commit[]>(host, M.gitLog, { path: ws.path, base: ws.base })
      .then((log) => {
        if (log.length === 1) setTitle(log[0].subject);
        setBody(log.map((c) => `- ${c.subject}`).join("\n"));
      })
      .catch(() => {});
  }, [host, ws]);
  if (!ws) return null;
  const create = async () => {
    setBusy(true);
    try {
      const pr = await rpc<PullRequest>(host, M.prCreate, { path: ws.path, title, body, base: ws.base, draft });
      toast(`Opened PR #${pr.number}`);
      useStore.setState({ rightTab: "review", rightOpen: true });
      close();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const uncommitted = s.git[`${host}/${ws.id}`]?.files.some((f) => f.unstaged || f.staged || f.status === "untracked");
  return (
    <Dialog
      title="Create pull request"
      width={560}
      onClose={close}
      footer={
        <>
          <label className="mr-auto flex items-center gap-1.5 ui-text-12 text-muted">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
          </label>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void create()}>
            {busy ? "Pushing…" : "Push and open PR"}
          </Button>
        </>
      }
    >
      <p className="mb-3 ui-text-12 text-muted">
        Pushes <span className="font-mono text-fg">{ws.branch}</span> to origin and opens a PR into <span className="font-mono text-fg">{ws.base}</span> with the GitHub CLI.
      </p>
      {uncommitted && <p className="mb-3 rounded-md border border-[#4a3b17] bg-[#2a2210] px-2 py-1.5 ui-text-12 text-blocked">There are uncommitted changes; they will not be in the PR.</p>}
      <Field label="Title">
        <input autoFocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea className={cx(inputCls, "min-h-[140px]")} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function HooksSection() {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc<HookStatus>("local", M.hooksStatus).then(setStatus).catch(() => {});
  }, []);
  const install = async () => {
    const ok = await askConfirm({
      title: "Install agent hooks",
      message: `moonlet will add its hooks to:\n• ${status?.claude_settings}\n• ${status?.codex_config}\n\nand a "moonlet" skill to the skills folder next to each.\n\nA backup of each file is written first and your own settings are kept.`,
      action: "Install",
    });
    if (!ok) return;
    setBusy(true);
    try {
      setStatus(await rpc<HookStatus>("local", M.hooksInstall, { claude: true, codex: !status?.codex_conflict }));
      toast("Agent hooks installed");
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 ui-text-12 font-semibold">Agent hooks</h3>
      <p className="mb-2 ui-text-12 text-muted">Hooks let Claude Code and Codex report exactly when they are working, waiting for approval, or done. The moonlet skill lets them open a session in another project.</p>
      {status && (
        <div className="mb-2 space-y-1 ui-text-12">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={13} className={status.claude_installed ? "text-done" : "text-faint"} /> Claude Code
            <span className="text-faint">{status.claude_installed ? "installed" : "not installed"}</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={13} className={status.codex_installed ? "text-done" : "text-faint"} /> Codex
            <span className="text-faint">{status.codex_installed ? "installed" : status.codex_conflict ? `skipped: already notifies "${status.codex_conflict}"` : "not installed"}</span>
          </div>
        </div>
      )}
      <Button variant="primary" disabled={busy || (status?.claude_installed && (status.codex_installed || !!status.codex_conflict))} onClick={() => void install()}>
        Install hooks
      </Button>
    </section>
  );
}

function HostsSection() {
  const hosts = useStore((s) => s.hosts);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void hostsApi.sshHosts().then(setSuggestions);
  }, []);
  const remotes = Object.values(hosts).filter((h) => h.remote);
  const install = async (id: string) => {
    const ok = await askConfirm({
      title: "Install remote helper",
      message: `Install the moonlet helper on ${id}?\n\nThe version-pinned moonletd binary (and the moonlet CLI) are copied to ~/.moonlet/bin over your SSH connection and verified by SHA-256. If the host has a ~/.jaunt folder from jaunt, it is moved to ~/.moonlet and ~/.jaunt becomes a link to it. Nothing else on the host is changed.`,
      action: "Install",
    });
    if (!ok) return;
    setBusy(id);
    try {
      const r = await hostsApi.install(id);
      toast(`Installed moonletd ${r.version} (${r.triple}) on ${id}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 ui-text-12 font-semibold">Remote hosts</h3>
      <p className="mb-2 ui-text-12 text-muted">Uses your own OpenSSH config, keys and agent. Sessions keep running on the host when the connection drops.</p>
      <div className="mb-2 space-y-1">
        {remotes.map((h) => (
          <div key={h.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 ui-text-12.5">
            <Server size={13} className="text-muted" />
            <span className="font-medium">{h.id}</span>
            <span className={cx("ui-text-11.5", h.status === "connected" ? "text-done" : h.status === "needs_install" || h.status === "error" ? "text-error" : "text-blocked")}>
              {h.status.replace("_", " ")}
            </span>
            {h.message && <span className="truncate ui-text-11 text-faint" title={h.message}>{h.message}</span>}
            <span className="ml-auto flex gap-1">
              {(h.status === "needs_install" || h.status === "connected") && (
                <Button size="sm" disabled={busy === h.id} onClick={() => void install(h.id)}>
                  {h.status === "connected" ? "Reinstall" : busy === h.id ? "Installing…" : "Install helper"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void hostsApi.remove(h.id).then(() => useStore.setState((s) => { const hs = { ...s.hosts }; delete hs[h.id]; return { hosts: hs }; }))}>
                <Trash2 size={12} />
              </Button>
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={inputCls} list="moonlet-ssh-hosts" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Host from ~/.ssh/config" />
        <datalist id="moonlet-ssh-hosts">
          {suggestions.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        <Button
          disabled={!alias.trim()}
          onClick={async () => {
            try {
              const info = await hostsApi.add(alias.trim());
              useStore.setState((s) => ({ hosts: { ...s.hosts, [info.id]: info } }));
              setAlias("");
            } catch (e) {
              errorToast(e);
            }
          }}
        >
          Add host
        </Button>
      </div>
    </section>
  );
}

function AgentsSection() {
  const mode = useStore((s) => resolveMode(s.settings.defaultMode));
  const planMode = useStore((s) => resolvePlanMode(s.settings.planApproveMode));
  const sounds = useStore((s) => s.settings.sounds);
  const toolCalls = useStore((s) => s.settings.toolCalls);
  return (
    <section>
      <h3 className="mb-2 ui-text-12 font-semibold">Agents</h3>
      <Field label="Default permission mode for new Claude sessions">
        <select className={inputCls} value={mode} onChange={(e) => updateSettings({ defaultMode: e.target.value })}>
          {CLAUDE_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.description}
            </option>
          ))}
        </select>
      </Field>
      <Field label="When a plan is approved, switch to">
        <select className={inputCls} value={planMode} onChange={(e) => updateSettings({ planApproveMode: e.target.value })}>
          {PLAN_APPROVE_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.description}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tool calls in the conversation">
        <select className={inputCls} value={toolCalls} onChange={(e) => updateSettings({ toolCalls: e.target.value as ToolCallView })}>
          <option value="collapsed">Collapsed · one row per run of calls</option>
          <option value="expanded">Expanded · one row per call</option>
        </select>
      </Field>
      <h4 className="mt-3 mb-1.5 ui-text-12 font-medium text-muted">Sounds when not watching the agent</h4>
      <div className="grid grid-cols-[90px_1fr_auto] items-center gap-x-2 gap-y-1.5 ui-text-12.5">
        {SOUND_EVENTS.map((ev) => {
          const current = soundFor(sounds, ev.id) ?? "";
          return (
            <div key={ev.id} className="contents">
              <span>{ev.label}</span>
              <select
                className={inputCls}
                value={current}
                onChange={(e) => updateSettings({ sounds: { ...DEFAULT_SOUNDS, ...sounds, [ev.id]: e.target.value } })}
              >
                <option value="">Off</option>
                {SYSTEM_SOUNDS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" disabled={!current} title="Play" onClick={() => void hostsApi.playSound(current).catch(errorToast)}>
                <Play size={12} />
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EditorSection() {
  const theme = useStore((s) => resolveEditorTheme(s.settings.editorTheme));
  return (
    <section className="mb-5">
      <h3 className="mb-2 ui-text-12 font-semibold">Editor</h3>
      <Field label="Colour theme of files and diffs">
        <select className={inputCls} value={theme} onChange={(e) => updateSettings({ editorTheme: e.target.value })}>
          {EDITOR_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
    </section>
  );
}

function TerminalSection() {
  const settings = useStore((s) => s.settings);
  const t = settings.term;
  const setTerm = (patch: Partial<typeof t>) => updateSettings({ term: { ...t, ...patch } });
  return (
    <section>
      <h3 className="mb-2 ui-text-12 font-semibold">Terminal</h3>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="Font family">
          <input className={inputCls} value={t.fontFamily} onChange={(e) => setTerm({ fontFamily: e.target.value })} />
        </Field>
        <Field label="Size">
          <input type="number" min={9} max={24} className={inputCls} value={t.fontSize} onChange={(e) => setTerm({ fontSize: Number(e.target.value) || 13 })} />
        </Field>
      </div>
      <div className="space-y-1.5 ui-text-12.5">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.optionIsMeta} onChange={(e) => setTerm({ optionIsMeta: e.target.checked })} /> Use Option as Meta
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.webgl} onChange={(e) => setTerm({ webgl: e.target.checked })} /> GPU rendering (WebGL)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.allowOsc52} onChange={(e) => setTerm({ allowOsc52: e.target.checked })} /> Let programs write to the clipboard (OSC 52)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={t.classicPrompt} onChange={(e) => setTerm({ classicPrompt: e.target.checked })} /> New shells keep their own prompt (classic, no input editor)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.notifyWhenFocused} onChange={(e) => updateSettings({ notifyWhenFocused: e.target.checked })} /> Notify even while moonlet is focused
        </label>
      </div>
    </section>
  );
}

function DaemonSection() {
  const [status, setStatus] = useState<{ installed: boolean; loaded: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void hostsApi.service("status").then(setStatus).catch(() => setStatus(null));
  }, []);
  const toggle = async (on: boolean) => {
    if (!on && status?.loaded) {
      const ok = await askConfirm({
        title: "Stop the background daemon",
        message: "Turning this off stops the daemon that launchd is running. Terminals and agents it holds may end. Turn it off?",
        action: "Turn off",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      setStatus(await hostsApi.service(on ? "install" : "uninstall"));
      toast(on ? "The moonlet daemon now starts at login" : "Login item removed");
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 ui-text-12 font-semibold">Background daemon</h3>
      <p className="mb-2 ui-text-12 text-muted">Agents run in moonletd, not in this window. Running it under launchd starts it at login and restarts it if it ever crashes.</p>
      <label className="flex items-center gap-2 ui-text-12.5">
        <input type="checkbox" disabled={busy || !status} checked={!!status?.installed} onChange={(e) => void toggle(e.target.checked)} /> Start the moonlet daemon at login
        {status?.installed && !status.loaded && <span className="ui-text-11 text-blocked">installed but not loaded</span>}
      </label>
    </section>
  );
}

export function SettingsDialog() {
  return (
    <Dialog title="Settings" width={600} onClose={close}>
      <HooksSection />
      <DaemonSection />
      <HostsSection />
      <AgentsSection />
      <EditorSection />
      <TerminalSection />
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  switch (dialog?.kind) {
    case "add-project":
      return <AddProjectDialog host={dialog.host} workspace={dialog.workspace} />;
    case "new-workspace":
      return <NewWorkspaceDialog />;
    case "new-session":
      return <Composer host={dialog.host} project={dialog.project} workspace={dialog.workspace} />;
    case "commit":
      return <CommitDialog />;
    case "create-pr":
      return <CreatePrDialog />;
    case "settings":
      return <SettingsDialog />;
    case "project-settings":
      return <ProjectSettingsDialog host={dialog.host} project={dialog.project} focus={dialog.focus} />;
    default:
      return null;
  }
}
