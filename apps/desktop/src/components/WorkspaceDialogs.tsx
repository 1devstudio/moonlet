// New workspace and Workspace settings (X32), with the Claude profile its
// sessions sign in with (X33).

import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/daemon";
import { M, type ClaudeProfile, type TerminalInfo, type Workspace, type WorkspaceColor } from "../lib/protocol";
import { askConfirm } from "../lib/confirm";
import { workspaceSections } from "../lib/sidebar";
import { errorToast, refreshProfile, sessionTerminals, shownWorkspace, switchWorkspace, toast, useStore } from "../lib/store";
import { WORKSPACE_COLORS, count, createRequest, deleteBlocked } from "../lib/workspaces";
import { footerLabel, profileChangeConfirm, profileOptions, tildePath } from "../lib/profiles";
import { User } from "lucide-react";
import { WorkspaceMark } from "./WorkspaceSwitcher";
import { TerminalPane } from "./TerminalPane";
import { Button, Dialog, Field, cx, inputCls } from "./ui";

const close = () => useStore.setState({ dialog: null });

function ColorPicker({ value, onChange }: { value: WorkspaceColor; onChange: (c: WorkspaceColor) => void }) {
  return (
    <div className="flex gap-2">
      {WORKSPACE_COLORS.map((c) => (
        <button
          key={c.id}
          aria-label={value === c.id ? `${c.label}, selected` : c.label}
          onClick={() => onChange(c.id)}
          className="h-6 w-6 rounded-md"
          style={{ background: c.hex, boxShadow: value === c.id ? "0 0 0 2px var(--color-panel, #161616), 0 0 0 4px #e6e6e6" : undefined }}
        />
      ))}
    </div>
  );
}

function NameField({ name, color, onChange, onEnter }: { name: string; color: WorkspaceColor; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <div className="mb-4 flex items-end gap-3">
      <WorkspaceMark name={name || "?"} color={color} size={36} />
      <label className="flex flex-1 flex-col gap-1.5">
        <span className="ui-text-12 text-muted">Name</span>
        <input autoFocus className={inputCls} value={name} onChange={(e) => onChange(e.target.value)} placeholder="CipherHealth" onKeyDown={(e) => e.key === "Enter" && onEnter()} />
      </label>
    </div>
  );
}

/** Runs `claude auth login` for a profile in a terminal (X33), then asks the
 * daemon who it is signed in as. */
export function SignInDialog({ host, profile, console: useConsole, onClose }: { host: string; profile: ClaudeProfile; console?: boolean; onClose: () => void }) {
  const [term, setTerm] = useState<number | null>(null);
  const exited = useStore((s) => (term !== null ? !!s.terminals[host]?.[term]?.exit : false));
  // Starts one login per open dialog, whatever the parent re-renders.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let id: number | null = null;
    void rpc<TerminalInfo>(host, M.terminalCreate, {
      cwd: profile.path,
      command: ["claude", "auth", "login", ...(useConsole ? ["--console"] : [])],
      env: { CLAUDE_CONFIG_DIR: profile.path },
      kind: "run",
      title: "claude auth login",
      cols: 100,
      rows: 24,
    })
      .then((t) => {
        id = t.id;
        setTerm(t.id);
      })
      .catch((e) => {
        errorToast(e);
        close.current();
      });
    return () => {
      if (id !== null) void rpc(host, M.terminalKill, { id, remove: true }).catch(() => {});
      void refreshProfile(host, profile.id);
    };
  }, [host, profile.id, profile.path, useConsole]);
  useEffect(() => {
    if (exited) close.current();
  }, [exited]);
  return (
    <Dialog title={`Sign in: ${profile.name}`} width={720} onClose={onClose}>
      <p className="mb-2 ui-text-12 text-muted">Finish signing in in your browser. This window closes when Claude Code is done.</p>
      <div className="h-[340px] overflow-hidden rounded-md border border-border bg-bg">{term !== null && <TerminalPane host={host} session={term} wsId="" focused visible />}</div>
    </Dialog>
  );
}

/** The sidebar footer: the account the shown workspace's agents use (X33). */
export function ProfileFooter() {
  const shown = useStore((s) => shownWorkspace(s));
  const ws = useStore((s) => (shown ? s.workspaces[shown.host]?.find((w) => w.id === shown.id) : undefined));
  const profiles = useStore((s) => (shown ? s.profiles[shown.host] : undefined));
  const home = useStore((s) => (shown ? (s.hosts[shown.host]?.home ?? null) : null));
  if (!shown || !ws) return null;
  const f = footerLabel(ws, profiles ?? [], home);
  return (
    <button
      title={f.title}
      onClick={() => useStore.setState({ dialog: { kind: "workspace-settings", host: shown.host, workspace: ws.id } })}
      className={cx("flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 ui-text-11.5 hover:bg-panel-2", f.warn ? "text-blocked" : "text-faint hover:text-muted")}
    >
      <User size={12} className="shrink-0" />
      <span className="truncate">{f.text}</span>
    </button>
  );
}

/** Settings → Claude profiles (X33). */
export function ProfilesSection() {
  const profiles = useStore((s) => s.profiles.local);
  const workspaces = useStore((s) => s.workspaces.local);
  const home = useStore((s) => s.hosts.local?.home ?? null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<ClaudeProfile | null>(null);
  if (!profiles?.length) return null;
  const remove = async (p: ClaudeProfile) => {
    const using = (workspaces ?? []).filter((w) => w.claude_profile === p.id).map((w) => w.name);
    const message = `Forget ${p.name}? ${using.length ? `${using.join(", ")} will use the default profile. ` : ""}The folder ${tildePath(p.path, home)} and its sign-in stay on disk.`;
    if (!(await askConfirm({ title: "Remove profile", message, action: "Remove" }))) return;
    try {
      await rpc("local", M.profileDelete, { id: p.id });
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <section className="mb-5">
      <h3 className="mb-1 ui-text-12 font-semibold">Claude profiles</h3>
      <p className="mb-2 ui-text-12 text-muted">Each profile is a Claude Code config folder with its own sign-in. A workspace picks one in Workspace settings.</p>
      <div className="space-y-1.5">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-2 rounded-md bg-panel-2 px-2.5 py-1.5 ui-text-12">
            <div className="min-w-0 flex-1">
              {renaming === p.id ? (
                <input
                  autoFocus
                  className={inputCls}
                  defaultValue={p.name}
                  onBlur={(e) => {
                    setRenaming(null);
                    const name = e.target.value.trim();
                    if (name && name !== p.name) void rpc("local", M.profileUpdate, { id: p.id, name }).catch(errorToast);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <div className="font-medium">{p.name}</div>
              )}
              <div className="truncate text-faint">
                {tildePath(p.path, home)} · {p.account?.logged_in ? [p.account.email, p.account.org_name].filter(Boolean).join(" · ") : p.account ? "not signed in" : "checking…"}
                {(workspaces ?? []).some((w) => w.claude_profile === p.id) && ` · used by ${(workspaces ?? []).filter((w) => w.claude_profile === p.id).map((w) => w.name).join(", ")}`}
              </div>
            </div>
            {!p.account?.logged_in && (
              <Button size="sm" onClick={() => setSignIn(p)}>
                Sign in…
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRenaming(p.id)}>
              Rename
            </Button>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => void remove(p)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      {signIn && <SignInDialog host="local" profile={signIn} onClose={() => setSignIn(null)} />}
    </section>
  );
}

/** The Claude profile select (X33): the default, every profile, New profile…. */
function ProfileField({ host, value, onChange }: { host: string; value: string; onChange: (v: string) => void }) {
  const profiles = useStore((s) => s.profiles[host]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [signIn, setSignIn] = useState<{ console: boolean } | null>(null);
  const options = profileOptions(profiles ?? [], home);
  const picked = (profiles ?? []).find((p) => p.id === value);
  const create = async () => {
    try {
      const p = await rpc<ClaudeProfile>(host, M.profileCreate, { name: name.trim(), path: folder.trim() || null });
      setCreating(false);
      setName("");
      setFolder("");
      onChange(p.id);
      void refreshProfile(host, p.id);
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Field label="Claude profile" hint="Every session in this workspace signs in with this account.">
      <select
        aria-label="Claude profile"
        className={inputCls}
        value={creating ? "new" : value}
        onChange={(e) => {
          if (e.target.value === "new") setCreating(true);
          else {
            setCreating(false);
            onChange(e.target.value);
          }
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {creating && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-[#1a1a1a] p-2.5">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Profile name, e.g. Work profile" />
          <input className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`Folder (default ~/.claude-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "name"})`} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
              Create profile
            </Button>
          </div>
        </div>
      )}
      {picked && !creating && (
        <div className="mt-1.5 flex items-center gap-2 ui-text-12">
          {picked.account?.logged_in ? (
            <span className="text-muted">Signed in as {[picked.account.email, picked.account.org_name].filter(Boolean).join(" · ") || "an account"}</span>
          ) : (
            <>
              <span className={picked.account ? "text-blocked" : "text-faint"}>{picked.account ? "Not signed in" : "Checking…"}</span>
              <Button size="sm" onClick={() => setSignIn({ console: false })}>
                Sign in…
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSignIn({ console: true })}>
                Use Console billing…
              </Button>
            </>
          )}
        </div>
      )}
      {signIn && picked && <SignInDialog host={host} profile={picked} console={signIn.console} onClose={() => setSignIn(null)} />}
    </Field>
  );
}

export function NewWorkspaceDialog() {
  const from = useStore((s) => shownWorkspace(s));
  const fromWs = useStore((s) => (from ? s.workspaces[from.host]?.find((w) => w.id === from.id) : undefined));
  const hostSections = useStore((s) => (from ? s.sections[from.host] : undefined));
  const fromSections = useMemo(() => (fromWs ? workspaceSections(fromWs, hostSections ?? []) : []), [fromWs, hostSections]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<WorkspaceColor>("blue");
  const [start, setStart] = useState<"empty" | "move">("empty");
  const [moving, setMoving] = useState<string[]>([]);
  const [profile, setProfile] = useState("");
  const req = createRequest({ name, color, start, moving });
  const create = async () => {
    if (!req || !from) return;
    try {
      const ws = await rpc<Workspace>(from.host, M.workspaceCreate, { ...req, claude_profile: profile || null });
      close();
      switchWorkspace({ host: from.host, id: ws.id });
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Dialog
      title="New workspace"
      width={440}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!req} onClick={() => void create()}>
            Create workspace
          </Button>
        </>
      }
    >
      <NameField name={name} color={color} onChange={setName} onEnter={() => void create()} />
      <Field label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      {from && <ProfileField host={from.host} value={profile} onChange={setProfile} />}
      {fromWs && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 ui-text-12 text-muted">Start with</legend>
          <label className="flex items-center gap-2.5 ui-text-13">
            <input type="radio" name="nw-start" checked={start === "empty"} onChange={() => setStart("empty")} className="accent-accent" /> An empty workspace
          </label>
          <label className={cx("flex items-center gap-2.5 ui-text-13", !fromSections.length && "text-faint")}>
            <input type="radio" name="nw-start" disabled={!fromSections.length} checked={start === "move"} onChange={() => setStart("move")} className="accent-accent" /> Move sections from {fromWs.name}
            {!fromSections.length && <span className="ui-text-11.5">(it has none)</span>}
          </label>
          {fromSections.length > 0 && (
          <div className={cx("ml-[22px] flex flex-col gap-0.5 rounded-lg border border-border bg-[#1a1a1a] p-1.5", start !== "move" && "opacity-50")}>
            {fromSections.map((sec) => (
              <label key={sec.id} className="flex h-7 items-center gap-2.5 px-1.5 ui-text-13">
                <input
                  type="checkbox"
                  disabled={start !== "move"}
                  checked={moving.includes(sec.id)}
                  onChange={(e) => setMoving((m) => (e.target.checked ? [...m, sec.id] : m.filter((x) => x !== sec.id)))}
                  className="accent-accent"
                />
                {sec.name}
                <span className="ml-auto ui-text-11.5 text-faint">{count(sec.project_ids.length, "project")}</span>
              </label>
            ))}
          </div>
          )}
        </fieldset>
      )}
    </Dialog>
  );
}

export function WorkspaceSettingsDialog({ host, workspace }: { host: string; workspace: string }) {
  const ws = useStore((s) => s.workspaces[host]?.find((w) => w.id === workspace));
  const count = useStore((s) => (s.workspaces[host] ?? []).length);
  const [name, setName] = useState(ws?.name ?? "");
  const [color, setColor] = useState<WorkspaceColor>(ws?.color ?? "clay");
  const [profile, setProfile] = useState(ws?.claude_profile ?? "");
  const profiles = useStore((s) => s.profiles[host]);
  // Sessions of this workspace with a live agent: they switch accounts when they restart.
  const agents = useStore((s) => (s.sessions[host] ?? []).filter((x) => !x.archived && x.workspace_id === workspace && sessionTerminals(s, host, x.id).some((t) => t.kind === "agent" && !t.exit)).length);
  if (!ws) return null;
  const blocked = deleteBlocked(ws, count);
  const save = async () => {
    if (profile !== (ws.claude_profile ?? "")) {
      const to = (profiles ?? []).find((p) => p.id === profile)?.name ?? "Default";
      const message = profileChangeConfirm(agents, to);
      if (message && !(await askConfirm({ title: "Change Claude profile", message, action: "Change profile" }))) return;
    }
    try {
      await rpc(host, M.workspaceUpdate, { id: ws.id, name: name.trim() || undefined, color, claude_profile: profile });
      close();
    } catch (e) {
      errorToast(e);
    }
  };
  const remove = async () => {
    if (!(await askConfirm({ title: "Delete workspace", message: `Delete ${ws.name}? It has no sections left, and its archived sessions move to another workspace.`, action: "Delete" }))) return;
    try {
      await rpc(host, M.workspaceDelete, { id: ws.id });
      close();
      toast(`Deleted ${ws.name}`);
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Dialog
      title="Workspace settings"
      width={440}
      onClose={close}
      footer={
        <>
          <span className="mr-auto" title={blocked ?? undefined}>
            <Button variant="ghost" disabled={!!blocked} onClick={() => void remove()} className="text-error">
              Delete workspace
            </Button>
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <NameField name={name} color={color} onChange={setName} onEnter={() => void save()} />
      <Field label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <ProfileField host={host} value={profile} onChange={setProfile} />
      {blocked && <p className="ui-text-12 text-faint">{blocked}</p>}
    </Dialog>
  );
}
