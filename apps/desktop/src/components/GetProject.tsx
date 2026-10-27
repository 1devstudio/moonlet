// Get <name> on <host> (X70): clone a project another member has from its
// origin into a section, or add a copy that is already on the host.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, FolderSearch, Loader2, RotateCw, ShieldAlert } from "lucide-react";
import { DaemonError, rpc } from "../lib/daemon";
import { M, type CloneTarget, type Project, type ProjectIdentity, type RepoInfo } from "../lib/protocol";
import { errorToast, toast, useStore } from "../lib/store";
import { hostSections } from "../lib/sidebar";
import { cloneKey, cloneParent, clonePath, targetTaken } from "../lib/addProject";
import { cantReach, copyCheck, foundLine, getProjectTitle, isTooOld, noOrigin, originName } from "../lib/getProject";
import { CloneInto, CloneProgressCard, TakenBox } from "./AddProject";
import { Button, Dialog, Field, cx, inputCls } from "./ui";

type Lookup = { state: "looking" } | { state: "found"; info: RepoInfo } | { state: "unreachable"; error: string } | { state: "too-old" };

const newCloneId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function GetProjectDialog({ host, section, identity, name, clone: watching }: { host: string; section: string; identity: ProjectIdentity; name: string; clone?: string }) {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const sections = useStore((s) => s.sections);
  const run = useStore((s) => (watching ? s.clones[watching] : undefined));
  const hostLabel = host === "local" ? "This Mac" : hosts[host]?.label || host;
  const workspace = hostSections(workspaces[host] ?? [], sections[host] ?? []).find((x) => x.sec.id === section)?.ws.id;
  const origin = identity.origin;
  const cloning = !!run && !run.error;
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [retry, setRetry] = useState(0);
  const [parent, setParent] = useState(() => cloneParent(host));
  const [folderName, setFolderName] = useState(() => (origin ? originName(origin) : name));
  const [target, setTarget] = useState<CloneTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [locating, setLocating] = useState(!origin);
  const [folder, setFolder] = useState("");
  const [copy, setCopy] = useState<{ folder: string; ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (run?.error && watching) useStore.setState((s) => ({ clones: Object.fromEntries(Object.entries(s.clones).filter(([k]) => k !== watching)) }));
    useStore.setState({ dialog: null });
  };
  const dialogState = (clone?: string) => ({ kind: "get-project" as const, host, section, identity, name, clone });

  useEffect(() => {
    if (!origin || cloning) return;
    setLookup({ state: "looking" });
    let live = true;
    rpc<RepoInfo>(host, M.repoLookup, { origin }).then(
      (info) => live && setLookup({ state: "found", info }),
      (e) => live && setLookup(e instanceof DaemonError && isTooOld(e) ? { state: "too-old" } : { state: "unreachable", error: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [host, origin, retry, cloning]);

  const found = lookup?.state === "found" ? lookup.info : null;
  useEffect(() => {
    setTarget(null);
    setTargetError(null);
    if (!found || !origin || !parent.trim() || !folderName.trim() || cloning) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc<CloneTarget>(host, M.repoCloneTarget, { origin, root: identity.root, parent, name: folderName }).then(
        (t) => live && setTarget(t),
        (e) => live && setTargetError(message(e)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, found, origin, identity.root, parent, folderName, cloning]);

  // Whether the folder the user located is a copy of the project.
  useEffect(() => {
    setCopy(null);
    const typed = folder.trim();
    if (!locating || !typed) return;
    let live = true;
    const timer = setTimeout(() => {
      rpc<ProjectIdentity>(host, M.projectIdentity, { path: typed }).then(
        (found) => live && setCopy({ folder: typed, ...copyCheck(found, identity, typed, name) }),
        (e) => live && setCopy({ folder: typed, ok: false, text: message(e) }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, locating, folder, identity, name]);

  /** Adds `path` to the section, as a copy of the project the daemon checks again. */
  const addCopy = async (path: string) => {
    setBusy(true);
    try {
      const project = await rpc<Project>(host, M.sectionAddProject, { id: section, path, identity });
      toast(`Added ${project.name}`);
      useStore.setState({ dialog: null });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const canClone = !!found && !!target && !target.exists && !busy && !cloning;
  const startClone = async () => {
    if (!found || !origin || !canClone) return;
    setBusy(true);
    // The run is known before the daemon answers, so no event is missed.
    const id = newCloneId();
    const key = cloneKey(host, id);
    useStore.setState((s) => {
      const { [watching ?? ""]: _, ...rest } = s.clones;
      return { clones: { ...rest, [key]: { host, job: { id, repo: origin, path: clonePath(parent, folderName) }, steps: {}, parent, workspace } }, dialog: dialogState(key) };
    });
    try {
      await rpc(host, M.repoClone, { id, origin, root: identity.root, url: found.url ?? null, parent, name: folderName, section_id: section });
    } catch (e) {
      useStore.setState((s) => {
        const { [key]: _, ...rest } = s.clones;
        return { clones: rest, dialog: dialogState() };
      });
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const cancelClone = () => {
    if (run) void rpc(run.host, M.repoCloneCancel, { id: run.job.id }).catch(errorToast);
  };

  const taken = found && origin && target ? targetTaken(target, origin, clonePath(parent, folderName)) : null;
  const reach = lookup?.state === "unreachable" && origin ? cantReach(hostLabel, origin, lookup.error) : null;
  const tooOld = lookup?.state === "too-old";

  const footer = tooOld ? (
    <Button onClick={close}>Close</Button>
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
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      {locating ? (
        <Button variant="primary" disabled={!copy?.ok || copy.folder !== folder.trim() || busy} onClick={() => void addCopy(folder.trim())}>
          Add this folder
        </Button>
      ) : (
        <Button variant="primary" disabled={!canClone} onClick={() => void startClone()}>
          Clone and add
        </Button>
      )}
    </>
  );

  return (
    <Dialog title={getProjectTitle(name, hostLabel)} width={560} onClose={close} footer={footer}>
      {tooOld ? (
        <p role="alert" className="ui-text-12.5 text-fg">
          {hostLabel}'s moonletd is too old to get this project. Update moonlet there.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-border bg-panel-2 px-3 py-2.5" aria-label="Project">
            <span aria-hidden className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded-[5px] border border-dashed border-border-strong" />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="ui-text-13 font-semibold">{name}</span>
              <span className="truncate font-mono ui-text-11.5 text-muted">{origin ?? "no remote"}</span>
              {found?.url && <span className="truncate font-mono ui-text-11 text-faint">{found.url}</span>}
            </div>
            {lookup?.state === "looking" && (
              <span className="flex shrink-0 items-center gap-1 ui-text-12 text-muted">
                <Loader2 size={12} className="animate-spin" /> Looking up…
              </span>
            )}
            {found && (
              <span className="flex shrink-0 items-center gap-1 ui-text-12 text-done">
                <Check size={12} /> {foundLine(found)}
              </span>
            )}
          </div>
          {!origin && <p className="mb-3 ui-text-12.5 leading-normal text-fg">{noOrigin(name, hostLabel)}</p>}
          {reach && (
            <div role="alert" className="-mt-1 mb-3 flex flex-col gap-2 rounded-lg border border-[#5a2a2a] bg-[#2a1616] px-3 py-2.5">
              <span className="flex items-center gap-2 ui-text-12.5 font-medium text-error">
                <ShieldAlert size={14} /> {reach.title}
              </span>
              <span className="ui-text-12 leading-normal text-fg">{reach.body}</span>
              {reach.details.map((d) => (
                <span key={d} className="font-mono ui-text-11 text-muted">
                  {d}
                </span>
              ))}
              <div>
                <Button size="sm" variant="ghost" onClick={() => setRetry((n) => n + 1)}>
                  <RotateCw size={12} /> Retry
                </Button>
              </div>
            </div>
          )}
          {origin && !locating && (found || cloning) && (
            <fieldset disabled={cloning} className={cx("min-w-0", cloning && "opacity-60")}>
              <CloneInto
                parent={parent}
                name={folderName}
                local={host === "local"}
                cloning={cloning}
                hostLabel={hostLabel}
                warn={!!taken}
                onParent={setParent}
                onName={setFolderName}
                onEnter={() => canClone && void startClone()}
              >
                {targetError && (
                  <span role="alert" className="ui-text-11.5 text-error">
                    {targetError}
                  </span>
                )}
                {taken && <TakenBox {...taken} onAddExisting={() => target && void addCopy(target.path)} onUseName={() => setFolderName(taken.useName)} />}
              </CloneInto>
            </fieldset>
          )}
          {locating ? (
            <Field label="Folder" hint={host === "local" ? undefined : `A path on ${hostLabel}. No Browse… for remote hosts.`}>
              <div className="flex gap-2">
                <input autoFocus spellCheck={false} aria-label="Folder" className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`~/code/${originName(origin ?? name)}`} />
                {host === "local" && (
                  <Button
                    onClick={async () => {
                      const dir = await openDialog({ directory: true, multiple: false, title: `Locate ${name}` });
                      if (typeof dir === "string") setFolder(dir);
                    }}
                  >
                    Browse…
                  </Button>
                )}
              </div>
              {copy && copy.folder === folder.trim() && (
                <span role={copy.ok ? "status" : "alert"} className={cx("mt-1.5 flex items-center gap-1.5 ui-text-11.5", copy.ok ? "text-done" : "text-error")}>
                  {copy.ok ? <Check size={12} /> : <ShieldAlert size={12} />} {copy.text}
                </span>
              )}
              {origin && (
                <button type="button" className="mt-2 self-start ui-text-12 text-muted hover:text-fg" onClick={() => setLocating(false)}>
                  Clone it instead
                </button>
              )}
            </Field>
          ) : (
            !cloning && (
              <div className="mt-1 border-t border-border pt-3">
                <button type="button" className="flex items-center gap-1.5 ui-text-12.5 text-muted hover:text-fg" onClick={() => setLocating(true)}>
                  <FolderSearch size={13} /> Locate a copy
                </button>
              </div>
            )
          )}
        </>
      )}
      {run?.error && (
        <div role="alert" className="mt-3 flex flex-col gap-1 rounded-lg border border-[#5a2a2a] bg-[#2a1616] px-3 py-2.5">
          <span className="flex items-center gap-2 ui-text-12.5 font-medium text-error">
            <ShieldAlert size={14} /> Cloning {name} failed
          </span>
          <span className="font-mono ui-text-12 text-fg">{run.error}</span>
        </div>
      )}
      {cloning && run && <CloneProgressCard run={run} />}
    </Dialog>
  );
}
