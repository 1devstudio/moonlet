// The Add project dialog: a local folder, or a clone from GitHub (X59).

import { useEffect, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowRight, Check, Copy, CornerDownLeft, Folder, FolderInput, GitBranch, Globe, Loader2, Lock, RotateCw, Search, ShieldAlert } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type CloneJob, type CloneTarget, type GhStatus, type Project, type RepoInfo, type RepoSummary } from "../lib/protocol";
import { errorToast, toast, useStore } from "../lib/store";
import { hostSections } from "../lib/sidebar";
import {
  cantSee,
  cloneKey,
  cloneParent,
  clonePercent,
  cloneStepRows,
  diskSize,
  ghLine,
  matchingRepos,
  pushedAgo,
  repoOwners,
  repoRef,
  targetTaken,
  type CloneRun,
} from "../lib/addProject";
import { Button, Dialog, Field, IconButton, cx, inputCls } from "./ui";
import { radioProps } from "./settings/controls";

const close = () => useStore.setState({ dialog: null });

type Tab = "folder" | "github";
type Lookup = { repo: string; state: "looking" } | { repo: string; state: "found"; info: RepoInfo } | { repo: string; state: "missing" };

const monoInputCls = cx(inputCls, "font-mono ui-text-12.5");

export function AddProjectDialog({ host: presetHost, section: presetSection, clone: watching }: { host?: string; section?: string; clone?: string }) {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const sections = useStore((s) => s.sections);
  const run = useStore((s) => (watching ? s.clones[watching] : undefined));
  const sectionsOf = (h: string) => hostSections(workspaces[h] ?? [], sections[h] ?? []);
  const [tab, setTab] = useState<Tab>("folder");
  const [host, setHost] = useState(run?.host ?? presetHost ?? "local");
  const [secId, setSecId] = useState(presetSection ?? sectionsOf(presetHost ?? "local")[0]?.sec.id ?? "");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  // Clone from GitHub
  const [repoText, setRepoText] = useState(run?.job.repo ?? "");
  const [parent, setParent] = useState(() => cloneParent(presetHost ?? "local"));
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [retry, setRetry] = useState(0);
  const [target, setTarget] = useState<CloneTarget | null>(null);
  const [highlight, setHighlight] = useState(0);

  const connected = Object.values(hosts).filter((h) => h.status === "connected");
  const hostLabel = host === "local" ? "This Mac" : hosts[host]?.label || host;
  const choices = sectionsOf(host);
  const ref = repoRef(repoText);
  const folderRepo = repoRef(path);
  const cloning = !!run && !run.error;
  const shownTab: Tab = run ? "github" : tab;

  useEffect(() => {
    if (shownTab !== "github") return;
    let live = true;
    setGh(null);
    setRepos(null);
    void rpc<GhStatus>(host, M.repoGhStatus)
      .then((status) => {
        if (!live) return;
        setGh(status);
        if (status.login) void rpc<RepoSummary[]>(host, M.repoList).then((list) => live && setRepos(list), () => live && setRepos([]));
      })
      .catch(() => live && setGh({ installed: false, login: null }));
    return () => {
      live = false;
    };
  }, [host, shownTab]);

  // Look the repository up after 300 ms without typing.
  useEffect(() => {
    if (shownTab !== "github" || !ref || cloning) return setLookup(null);
    const repo = ref.repo;
    setLookup({ repo, state: "looking" });
    if (!nameEdited) setName(repo.split("/")[1]);
    let live = true;
    const timer = setTimeout(() => {
      rpc<RepoInfo>(host, M.repoLookup, { repo, ssh: ref.ssh }).then(
        (info) => live && setLookup({ repo, state: "found", info }),
        () => live && setLookup({ repo, state: "missing" }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, shownTab, ref?.repo, ref?.ssh, retry, cloning]);

  const found = lookup?.state === "found" ? lookup.info : null;
  useEffect(() => {
    setTarget(null);
    if (!found || !parent.trim() || !name.trim() || cloning) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc<CloneTarget>(host, M.repoCloneTarget, { repo: found.repo, parent, name }).then(
        (t) => live && setTarget(t),
        () => live && setTarget(null),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, found, parent, name, cloning]);

  const pickHost = (h: string) => {
    setHost(h);
    setSecId(sectionsOf(h)[0]?.sec.id ?? "");
    setParent(cloneParent(h));
  };

  const addFolder = async (folder: string) => {
    setBusy(true);
    try {
      const project = secId ? await rpc<Project>(host, M.sectionAddProject, { id: secId, path: folder }) : await rpc<Project>(host, M.projectAdd, { path: folder });
      toast(`Added ${project.name}`);
      const ws = choices.find((x) => x.sec.id === secId)?.ws.id;
      useStore.setState({ dialog: { kind: "new-session", host, project: project.id, workspace: ws } });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  /** Forgets a failed clone the dialog shows, once the user edits the form. */
  const clearFailure = () => {
    if (!watching || !run?.error) return;
    useStore.setState((s) => {
      const { [watching]: _, ...rest } = s.clones;
      return { clones: rest, dialog: { kind: "add-project", host: presetHost, section: presetSection } };
    });
  };

  const startClone = async () => {
    if (!found || !target || target.exists) return;
    clearFailure();
    setBusy(true);
    try {
      const job = await rpc<CloneJob>(host, M.repoClone, { repo: found.repo, ssh: ref?.ssh, parent, name, section_id: secId || undefined });
      const key = cloneKey(host, job.id);
      const workspace = choices.find((x) => x.sec.id === secId)?.ws.id;
      useStore.setState((s) => ({
        clones: { ...s.clones, [key]: { ...(s.clones[key] ?? { host, job, steps: {} }), parent, workspace } },
        dialog: { kind: "add-project", host, section: secId || undefined, clone: key },
      }));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const cancelClone = () => {
    if (run) void rpc(run.host, M.repoCloneCancel, { id: run.job.id }).catch(errorToast);
  };

  const listing = shownTab === "github" && !ref && !!gh?.login && !cloning;
  const shownRepos = listing ? matchingRepos(repos ?? [], repoText) : [];
  const pickable = shownRepos.filter((r) => !r.added);
  const pick = (repo: string) => {
    clearFailure();
    setRepoText(repo);
    setNameEdited(false);
  };
  const shownPath = `${parent.trim().replace(/\/+$/, "")}/${name.trim()}`;
  const taken = found && target ? targetTaken(target, found.repo, shownPath) : null;
  const canClone = !!found && !!target && !target.exists && !busy;

  const footer =
    shownTab === "folder" ? (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!path || busy || !!folderRepo} onClick={() => void addFolder(path)}>
          Add project
        </Button>
      </>
    ) : cloning ? (
      <>
        <span className="mr-auto ui-text-12 text-muted">Closing keeps the clone running in the background.</span>
        <Button variant="ghost" onClick={cancelClone}>
          Cancel clone
        </Button>
        <Button variant="primary" disabled>
          <Loader2 size={13} className="animate-spin" /> Cloning…
        </Button>
      </>
    ) : (
      <>
        {gh && <GhLine {...ghLine(hostLabel, gh)} />}
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canClone} onClick={() => void startClone()}>
          Clone and add
        </Button>
      </>
    );

  return (
    <Dialog title="Add project" width={560} onClose={close} footer={footer}>
      <p className="mb-3 ui-text-12.5 text-muted">A project is a git repository folder. Each session you start in it gets its own worktree and branch.</p>
      <SourceSwitch
        value={shownTab}
        disabled={cloning}
        onChange={(t) => {
          clearFailure();
          setTab(t);
        }}
      />
      <fieldset disabled={cloning} className={cx("min-w-0", cloning && "opacity-60")}>
        {connected.length > 1 && (
          <Field label="Host">
            <select className={inputCls} value={host} onChange={(e) => pickHost(e.target.value)}>
              {connected.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {shownTab === "folder" ? (
          <Field label="Folder" hint={folderRepo ? undefined : host === "local" ? "Any folder inside a git repository." : "Path on the remote host, e.g. ~/src/api"}>
            <div className="flex gap-2">
              <input
                autoFocus
                spellCheck={false}
                className={cx(inputCls, folderRepo && "border-accent")}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="~/code/my-project"
                onKeyDown={(e) => e.key === "Enter" && path && !folderRepo && void addFolder(path)}
              />
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
            {folderRepo && (
              <div role="status" className="mt-2 flex items-center gap-2.5 rounded-lg border border-[#4a3326] bg-selected px-2.5 py-2">
                <Globe size={14} className="shrink-0 text-accent-2" />
                <span className="flex-1 ui-text-12.5 text-fg">That's a GitHub repository, not a folder.</span>
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault();
                    setRepoText(path);
                    setNameEdited(false);
                    setTab("github");
                  }}
                >
                  Clone {folderRepo.repo} <ArrowRight size={12} />
                </Button>
              </div>
            )}
          </Field>
        ) : (
          <>
            <RepositoryField
              text={repoText}
              listing={listing}
              invalid={lookup?.state === "missing"}
              onChange={(t) => {
                clearFailure();
                setRepoText(t);
                setHighlight(0);
              }}
              onKeyDown={(e) => {
                if (listing && pickable.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    setHighlight((h) => (h + step + pickable.length) % pickable.length);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    pick(pickable[Math.min(highlight, pickable.length - 1)].repo);
                  }
                } else if (e.key === "Enter" && canClone) void startClone();
              }}
            />
            {listing && repos && shownRepos.length > 0 && (
              <RepoList repos={shownRepos} login={gh?.login ?? null} highlighted={pickable[Math.min(highlight, pickable.length - 1)]?.repo} onPick={pick} />
            )}
            {!ref && !cloning && <p className="-mt-1 mb-3 ui-text-11 text-faint">{listing ? "Not listed? Type " : "Type "}<span className="font-mono">owner/repo</span> or paste any URL you can access.</p>}
            {ref && lookup?.state === "looking" && <p className="-mt-1 mb-3 ui-text-12 text-muted">Looking up {lookup.repo}…</p>}
            {ref && lookup?.state === "missing" && gh && <CantSee {...cantSee(hostLabel, lookup.repo, gh)} onRetry={() => setRetry((n) => n + 1)} />}
            {found && !cloning && <RepoCard info={found} />}
            {(found || cloning) && (
              <CloneInto
                parent={parent}
                name={name}
                local={host === "local"}
                cloning={cloning}
                hostLabel={hostLabel}
                warn={!!taken}
                onParent={(p) => {
                  clearFailure();
                  setParent(p);
                }}
                onName={(n) => {
                  clearFailure();
                  setName(n);
                  setNameEdited(true);
                }}
                onEnter={() => canClone && void startClone()}
              >
                {taken && (
                  <TakenBox
                    {...taken}
                    onAddExisting={() => target && void addFolder(target.path)}
                    onUseName={() => {
                      setName(taken.useName);
                      setNameEdited(true);
                    }}
                  />
                )}
              </CloneInto>
            )}
          </>
        )}
        {choices.length > 0 && !cloning && (
          <Field label="Section">
            <select className={inputCls} value={secId} onChange={(e) => setSecId(e.target.value)}>
              {choices.map(({ sec, label }) => (
                <option key={sec.id} value={sec.id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </fieldset>
      {run?.error && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-[#5a2a2a] bg-[#2a1616] px-3 py-2.5">
          <span className="flex items-center gap-2 ui-text-12.5 font-medium text-error">
            <ShieldAlert size={14} /> Cloning {run.job.repo} failed
          </span>
          <span className="font-mono ui-text-12 text-fg">{run.error}</span>
        </div>
      )}
      {cloning && run && <CloneProgressCard run={run} />}
    </Dialog>
  );
}

function SourceSwitch({ value, disabled, onChange }: { value: Tab; disabled: boolean; onChange: (t: Tab) => void }) {
  const options: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "folder", label: "Local folder", icon: <Folder size={13} /> },
    { id: "github", label: "Clone from GitHub", icon: <Globe size={13} /> },
  ];
  const checked = options.findIndex((o) => o.id === value);
  return (
    <div role="radiogroup" aria-label="Source" className={cx("mb-3 flex gap-0.5 rounded-[7px] border border-border-strong bg-panel-2 p-0.5", disabled && "opacity-60")}>
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          disabled={disabled}
          {...radioProps(i, checked, options.length, (k) => onChange(options[k].id))}
          className={cx(
            "flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 ui-text-12.5",
            o.id === value ? "bg-raised text-fg shadow-[0_0_0_1px_var(--color-border-strong)]" : "text-muted hover:text-fg",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RepositoryField({
  text,
  listing,
  invalid,
  onChange,
  onKeyDown,
}: {
  text: string;
  listing: boolean;
  invalid: boolean;
  onChange: (t: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <Field label="Repository" hint={listing ? undefined : "A GitHub URL, owner/repo, or an SSH address."}>
      <div className={cx(inputCls, "flex items-center gap-2 py-0", invalid && "border-error focus-within:border-error", !invalid && "focus-within:border-accent")}>
        {listing && <Search size={13} className="shrink-0 text-faint" />}
        <input
          autoFocus
          spellCheck={false}
          aria-label="Repository"
          aria-invalid={invalid}
          className="h-[30px] min-w-0 flex-1 bg-transparent ui-text-13 text-fg outline-none placeholder:text-faint"
          placeholder={listing ? "Paste a URL or search your repositories" : "https://github.com/acme/storefront"}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </Field>
  );
}

function OwnerTile({ repo, login, size }: { repo: string; login: string | null; size: number }) {
  const owner = repo.split("/")[0];
  const mine = !!login && owner.toLowerCase() === login.toLowerCase();
  return (
    <span
      aria-hidden="true"
      className={cx("flex shrink-0 items-center justify-center rounded-md font-semibold", mine ? "bg-[#1b2333] text-[#7ea6f0]" : "bg-selected text-accent-2")}
      style={{ width: size, height: size, fontSize: size > 28 ? 13 : 12 }}
    >
      {owner[0]?.toUpperCase()}
    </span>
  );
}

function RepoList({ repos, login, highlighted, onPick }: { repos: RepoSummary[]; login: string | null; highlighted?: string; onPick: (repo: string) => void }) {
  const now = new Date();
  return (
    <div className="-mt-1 mb-2 flex flex-col overflow-hidden rounded-lg border border-border bg-panel-2" role="listbox" aria-label="Your repositories">
      <div className="flex items-center justify-between px-2.5 pt-[7px] pb-[5px] ui-text-11 text-faint">
        <span className="font-medium text-muted">Your repositories</span>
        <span>from gh · {repoOwners(repos)}</span>
      </div>
      {repos.map((r) => {
        const [owner, name] = r.repo.split("/");
        const on = r.repo === highlighted;
        return (
          <button
            key={r.repo}
            type="button"
            role="option"
            aria-selected={on}
            disabled={r.added}
            onClick={() => onPick(r.repo)}
            className={cx("flex w-full items-center gap-2.5 border-t border-border px-2.5 py-[7px] text-left", on ? "bg-hover" : "hover:bg-hover", r.added && "cursor-default opacity-60 hover:bg-transparent")}
          >
            <OwnerTile repo={r.repo} login={login} size={26} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="flex items-center gap-1.5 ui-text-13">
                <span>
                  <span className="text-muted">{owner}/</span>
                  {name}
                </span>
                {r.private && <Lock size={11} className="text-faint" aria-label="Private" />}
              </span>
              {r.description && <span className="truncate ui-text-11.5 text-faint">{r.description}</span>}
            </span>
            {r.added ? (
              <span className="shrink-0 rounded-full border border-border-strong px-1.5 py-px ui-text-11 text-muted">Already added</span>
            ) : on ? (
              <kbd className="rounded border border-border-strong bg-panel-2 px-1 text-faint">
                <CornerDownLeft size={10} />
              </kbd>
            ) : (
              r.pushed_at && <span className="shrink-0 ui-text-11.5 text-faint">{pushedAgo(r.pushed_at, now)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function RepoCard({ info }: { info: RepoInfo }) {
  const meta = [info.default_branch, info.pushed_at && `pushed ${pushedAgo(info.pushed_at, new Date())}`, info.disk_kb !== null && diskSize(info.disk_kb)].filter(Boolean).join(" · ");
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-border bg-panel-2 px-3 py-2.5" aria-label="Repository found">
      <OwnerTile repo={info.repo} login={null} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-1.5 ui-text-13 font-semibold">
          {info.repo}
          {info.private && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border-strong px-1.5 py-px ui-text-11 font-normal text-muted">
              <Lock size={10} /> Private
            </span>
          )}
        </span>
        {info.description && <span className="ui-text-12.5 text-muted">{info.description}</span>}
        {meta && (
          <span className="flex items-center gap-1.5 font-mono ui-text-11.5 text-faint">
            <GitBranch size={11} /> {meta}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 ui-text-12 text-done">
        <Check size={12} /> Found
      </span>
    </div>
  );
}

function CantSee({ title, body, signIn, onRetry }: { title: string; body: string; signIn: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="-mt-1 mb-3 flex flex-col gap-2 rounded-lg border border-[#5a2a2a] bg-[#2a1616] px-3 py-2.5">
      <span className="flex items-center gap-2 ui-text-12.5 font-medium text-error">
        <ShieldAlert size={14} /> {title}
      </span>
      <span className="ui-text-12 leading-normal text-fg">{body}</span>
      <div className="flex items-center gap-1.5">
        {signIn && (
          <>
            <code className="flex h-[26px] min-w-0 flex-1 items-center rounded-md border border-border-strong bg-bg px-2 font-mono ui-text-12 text-fg">gh auth login</code>
            <IconButton title="Copy command" onClick={() => void navigator.clipboard.writeText("gh auth login").then(() => toast("Copied gh auth login"), errorToast)}>
              <Copy size={13} />
            </IconButton>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RotateCw size={12} /> Retry
        </Button>
      </div>
    </div>
  );
}

function CloneInto({
  parent,
  name,
  local,
  cloning,
  hostLabel,
  warn,
  onParent,
  onName,
  onEnter,
  children,
}: {
  parent: string;
  name: string;
  local: boolean;
  cloning: boolean;
  hostLabel: string;
  warn: boolean;
  onParent: (p: string) => void;
  onName: (n: string) => void;
  onEnter: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      <span className="ui-text-11.5 font-medium text-muted">Clone into</span>
      <div className="flex items-center gap-1.5">
        <input aria-label="Parent folder" spellCheck={false} className={cx(monoInputCls, "min-w-0 flex-1")} value={parent} onChange={(e) => onParent(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter()} />
        <span aria-hidden="true" className="font-mono ui-text-13 text-faint">
          /
        </span>
        <input
          aria-label="Folder name"
          aria-invalid={warn}
          spellCheck={false}
          className={cx(monoInputCls, "w-[150px]", warn && "border-blocked focus:border-blocked")}
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onEnter()}
        />
        {local && !cloning && (
          <Button
            onClick={async () => {
              const dir = await openDialog({ directory: true, multiple: false, title: "Choose where to clone" });
              if (typeof dir === "string") onParent(dir);
            }}
          >
            Browse…
          </Button>
        )}
      </div>
      {children}
      {!cloning && !children && <span className="ui-text-11 text-faint">{local ? "The parent folder is remembered for the next clone." : `A path on ${hostLabel}. No Browse… for remote hosts.`}</span>}
    </div>
  );
}

function TakenBox({ title, body, addExisting, useName, onAddExisting, onUseName }: { title: string; body: string; addExisting: boolean; useName: string; onAddExisting: () => void; onUseName: () => void }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-[#4a3b17] bg-[#2a2210] px-3 py-2.5">
      <span className="flex items-center gap-2 ui-text-12.5 font-medium text-blocked">
        <ShieldAlert size={14} /> <span className="font-mono">{title.replace(/ already exists$/, "")}</span> already exists
      </span>
      <span className="ui-text-12 leading-normal text-fg">{body}</span>
      <div className="flex gap-1.5">
        {addExisting && (
          <Button size="sm" onClick={onAddExisting}>
            <FolderInput size={12} /> Add existing folder
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onUseName}>
          Use {useName}
        </Button>
      </div>
    </div>
  );
}

function GhLine({ text, ok }: { text: string; ok: boolean }) {
  return (
    <span className="mr-auto flex items-center gap-1.5 ui-text-12 text-muted">
      {ok ? <Check size={13} className="text-done" /> : <span className="mx-[3px] h-1.5 w-1.5 rounded-full bg-idle" />}
      {text}
    </span>
  );
}

function CloneProgressCard({ run }: { run: CloneRun }) {
  const percent = clonePercent(run.steps);
  const shownPath = run.parent ? `${run.parent.replace(/\/+$/, "")}/${run.job.path.split("/").pop()}` : run.job.path;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2 rounded-lg border border-border bg-panel-2 p-3">
      <div className="flex items-center gap-2.5">
        <OwnerTile repo={run.job.repo} login={null} size={28} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="ui-text-13">
            Cloning <span className="font-semibold">{run.job.repo}</span>
          </span>
          <span className="truncate font-mono ui-text-11.5 text-faint">into {shownPath}</span>
        </div>
        <span className="font-mono ui-text-12 text-fg">{percent}%</span>
      </div>
      <div role="progressbar" aria-label="Clone progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex flex-col gap-0.5 font-mono ui-text-11.5 leading-normal">
        {cloneStepRows(run.steps).map((row) => (
          <span key={row.text.split(" ")[0]} className={cx("flex items-center gap-1.5", row.state === "done" ? "text-muted" : row.state === "running" ? "text-fg" : "text-faint")}>
            {row.state === "done" ? <Check size={11} className="text-done" /> : row.state === "running" ? <Loader2 size={11} className="animate-spin text-accent" /> : <span className="inline-block w-[11px]" />}
            {row.text}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-faint">
          <span className="inline-block w-[11px]" />
          Then: open the new session composer
        </span>
      </div>
    </div>
  );
}
