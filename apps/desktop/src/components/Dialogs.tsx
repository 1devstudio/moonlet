import { useEffect, useMemo, useState } from "react";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, Server, Trash2 } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type Commit, type HookStatus, type PullRequest, type Repo, type RepoConfig, type Workspace } from "../lib/protocol";
import { errorToast, refreshGit, repoOf, selectWorkspace, selectedWorkspace, toast, updateSettings, useStore } from "../lib/store";
import { Button, Dialog, Field, Kbd, cx, inputCls } from "./ui";

const close = () => useStore.setState({ dialog: null });

export function AddRepoDialog() {
  const hosts = useStore((s) => s.hosts);
  const [host, setHost] = useState("local");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = Object.values(hosts).filter((h) => h.status === "connected");
  const add = async () => {
    setBusy(true);
    try {
      const repo = await rpc<Repo>(host, M.repoAdd, { path });
      toast(`Added ${repo.name}`);
      useStore.setState({ dialog: { kind: "new-workspace", host, repo: repo.id } });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add repository"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!path || busy} onClick={() => void add()}>
            Add repository
          </Button>
        </>
      }
    >
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
      <Field label="Folder" hint={host === "local" ? "Any folder inside a git repository." : "Path on the remote host, e.g. ~/src/api"}>
        <div className="flex gap-2">
          <input autoFocus className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/my-repo" onKeyDown={(e) => e.key === "Enter" && path && void add()} />
          {host === "local" && (
            <Button
              onClick={async () => {
                const dir = await openDialog({ directory: true, multiple: false, title: "Choose a repository" });
                if (typeof dir === "string") setPath(dir);
              }}
            >
              Browse…
            </Button>
          )}
        </div>
      </Field>
    </Dialog>
  );
}

export function NewWorkspaceDialog({ host: presetHost, repo: presetRepo }: { host?: string; repo?: string }) {
  const hosts = useStore((s) => s.hosts);
  const allRepos = useStore((s) => s.repos);
  const options = useMemo(
    () => Object.entries(allRepos).flatMap(([h, list]) => (hosts[h]?.status === "connected" ? list.map((r) => ({ host: h, repo: r })) : [])),
    [allRepos, hosts],
  );
  const [choice, setChoice] = useState(() => {
    const pre = options.find((o) => o.host === presetHost && o.repo.id === presetRepo) ?? options[0];
    return pre ? `${pre.host}|${pre.repo.id}` : "";
  });
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("claude");
  const [prompt, setPrompt] = useState("");
  const [from, setFrom] = useState("");
  const [existing, setExisting] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [config, setConfig] = useState<RepoConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [host, repoId] = choice.split("|");
  const repo = options.find((o) => o.host === host && o.repo.id === repoId)?.repo;

  useEffect(() => {
    if (!repo) return;
    void rpc<RepoConfig>(host, M.repoConfig, { id: repo.id })
      .then((c) => {
        setConfig(c);
        if (c.default_agent) setAgent(c.default_agent);
      })
      .catch(() => setConfig(null));
    void rpc<string[]>(host, M.gitBranches, { path: repo.path }).then(setBranches).catch(() => setBranches([]));
  }, [host, repo]);

  const agents = ["claude", "codex", ...Object.keys(config?.agents ?? {}).filter((a) => a !== "claude" && a !== "codex"), "none"];

  const create = async () => {
    if (!repo) return;
    setBusy(true);
    try {
      const ws = await rpc<Workspace>(host, M.wsCreate, {
        repo_id: repo.id,
        name: name.trim() || prompt.trim().split("\n")[0].slice(0, 48) || "New task",
        agent,
        prompt: prompt.trim() || null,
        from: !existing && from ? from : null,
        existing_branch: existing,
        branch: existing ? from : null,
        cols: 120,
        rows: 32,
      });
      close();
      selectWorkspace(host, ws.id);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  if (!options.length) {
    return (
      <Dialog title="New workspace" onClose={close}>
        <p className="mb-3 text-muted">Add a repository first.</p>
        <Button variant="primary" onClick={() => useStore.setState({ dialog: { kind: "add-repo" } })}>
          Add repository…
        </Button>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New workspace"
      width={560}
      onClose={close}
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-faint">
            Creates a git worktree on its own branch{config?.setup ? " and runs the setup script" : ""}.
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !repo || (existing && !from)} onClick={() => void create()}>
            {busy ? "Creating…" : "Create"} <Kbd>⌘↵</Kbd>
          </Button>
        </>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) void create();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repository">
            <select className={inputCls} value={choice} onChange={(e) => setChoice(e.target.value)}>
              {options.map((o) => (
                <option key={o.host + o.repo.id} value={`${o.host}|${o.repo.id}`}>
                  {o.repo.name}
                  {o.host !== "local" ? ` (${o.host})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent">
            <select className={inputCls} value={agent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a === "none" ? "No agent (shell)" : a}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Task name" hint={name ? `Branch: jaunt/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : undefined}>
          <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Fix flaky login test" />
        </Field>
        {agent !== "none" && (
          <Field label="First prompt (optional)">
            <textarea className={cx(inputCls, "min-h-[84px] resize-y")} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the task for the agent…" />
          </Field>
        )}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label={existing ? "Existing branch" : `Start from (default ${repo?.base_branch ?? "base"})`}>
            <input className={inputCls} list="jaunt-branches" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={existing ? "feature/x" : repo?.base_branch} />
            <datalist id="jaunt-branches">
              {branches.slice(0, 200).map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </Field>
          <label className="mb-4 flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} /> Use existing branch
          </label>
        </div>
      </div>
    </Dialog>
  );
}

export function CommitDialog() {
  const s = useStore.getState();
  const ws = selectedWorkspace(s);
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
          <label className="mr-auto flex items-center gap-1.5 text-[12px] text-muted">
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
        className={cx(inputCls, "min-h-[110px] font-mono text-[12.5px]")}
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
  const ws = selectedWorkspace(s);
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
      useStore.setState({ rightTab: "checks", rightOpen: true });
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
          <label className="mr-auto flex items-center gap-1.5 text-[12px] text-muted">
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
      <p className="mb-3 text-[12px] text-muted">
        Pushes <span className="font-mono text-fg">{ws.branch}</span> to origin and opens a PR into <span className="font-mono text-fg">{ws.base}</span> with the GitHub CLI.
      </p>
      {uncommitted && <p className="mb-3 rounded-md border border-[#4a3b17] bg-[#2a2210] px-2 py-1.5 text-[12px] text-blocked">There are uncommitted changes; they will not be in the PR.</p>}
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
    const ok = await ask(
      `jaunt will add its hooks to:\n• ${status?.claude_settings}\n• ${status?.codex_config}\n\nA backup of each file is written first and your own settings are kept.`,
      { title: "Install agent hooks", kind: "info", okLabel: "Install" },
    );
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
      <h3 className="mb-1 text-[12px] font-semibold">Agent hooks</h3>
      <p className="mb-2 text-[12px] text-muted">Hooks let Claude Code and Codex report exactly when they are working, waiting for approval, or done.</p>
      {status && (
        <div className="mb-2 space-y-1 text-[12px]">
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
    const ok = await ask(
      `Install the jaunt helper on ${id}?\n\nThe version-pinned jauntd binary (and the jaunt CLI) are copied to ~/.jaunt/bin over your SSH connection and verified by SHA-256. Nothing else on the host is changed.`,
      { title: "Install remote helper", kind: "info", okLabel: "Install" },
    );
    if (!ok) return;
    setBusy(id);
    try {
      const r = await hostsApi.install(id);
      toast(`Installed jauntd ${r.version} (${r.triple}) on ${id}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 text-[12px] font-semibold">Remote hosts</h3>
      <p className="mb-2 text-[12px] text-muted">Uses your own OpenSSH config, keys and agent. Sessions keep running on the host when the connection drops.</p>
      <div className="mb-2 space-y-1">
        {remotes.map((h) => (
          <div key={h.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12.5px]">
            <Server size={13} className="text-muted" />
            <span className="font-medium">{h.id}</span>
            <span className={cx("text-[11.5px]", h.status === "connected" ? "text-done" : h.status === "needs_install" || h.status === "error" ? "text-error" : "text-blocked")}>
              {h.status.replace("_", " ")}
            </span>
            {h.message && <span className="truncate text-[11px] text-faint" title={h.message}>{h.message}</span>}
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
        <input className={inputCls} list="jaunt-ssh-hosts" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Host from ~/.ssh/config" />
        <datalist id="jaunt-ssh-hosts">
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

function TerminalSection() {
  const settings = useStore((s) => s.settings);
  const t = settings.term;
  const setTerm = (patch: Partial<typeof t>) => updateSettings({ term: { ...t, ...patch } });
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold">Terminal</h3>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="Font family">
          <input className={inputCls} value={t.fontFamily} onChange={(e) => setTerm({ fontFamily: e.target.value })} />
        </Field>
        <Field label="Size">
          <input type="number" min={9} max={24} className={inputCls} value={t.fontSize} onChange={(e) => setTerm({ fontSize: Number(e.target.value) || 13 })} />
        </Field>
      </div>
      <div className="space-y-1.5 text-[12.5px]">
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
          <input type="checkbox" checked={settings.notifyWhenFocused} onChange={(e) => updateSettings({ notifyWhenFocused: e.target.checked })} /> Notify even while jaunt is focused
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
    setBusy(true);
    try {
      setStatus(await hostsApi.service(on ? "install" : "uninstall"));
      toast(on ? "The jaunt daemon now starts at login" : "Login item removed");
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 text-[12px] font-semibold">Background daemon</h3>
      <p className="mb-2 text-[12px] text-muted">Agents run in jauntd, not in this window. Running it under launchd starts it at login and restarts it if it ever crashes.</p>
      <label className="flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" disabled={busy || !status} checked={!!status?.installed} onChange={(e) => void toggle(e.target.checked)} /> Start the jaunt daemon at login
        {status?.installed && !status.loaded && <span className="text-[11px] text-blocked">installed but not loaded</span>}
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
      <TerminalSection />
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const ws = useStore((s) => selectedWorkspace(s));
  const repo = useStore((s) => (ws && s.selected ? repoOf(s, s.selected.host, ws) : undefined));
  void repo;
  switch (dialog?.kind) {
    case "add-repo":
      return <AddRepoDialog />;
    case "new-workspace":
      return <NewWorkspaceDialog host={dialog.host} repo={dialog.repo} />;
    case "commit":
      return <CommitDialog />;
    case "create-pr":
      return <CreatePrDialog />;
    case "settings":
      return <SettingsDialog />;
    default:
      return null;
  }
}
