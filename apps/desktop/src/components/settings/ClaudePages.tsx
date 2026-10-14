// Settings › Claude Code (X43): this Mac's profiles (X33) and the agent
// hooks (A2).

import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { rpc } from "../../lib/daemon";
import { M, type ClaudeProfile, type HookStatus, type ProfileAccount, type Workspace } from "../../lib/protocol";
import { errorToast, refreshProfile, toast, useStore } from "../../lib/store";
import { accountState, defaultFolder, removeProfileConfirm, tildePath } from "../../lib/profiles";
import { hookRows, hooksDone, installHooksMessage, profileLine } from "../../lib/settingsPage";
import { colorHex } from "../../lib/workspaces";
import { ClaudeAuthDialog } from "../Profiles";
import { AgentIcon, Button, IconButton, cx } from "../ui";
import { Card, Initial, PageHeading, Status, fieldCls } from "./controls";

/** A workspace that uses a profile, as a chip with its colour. */
function WorkspaceChip({ ws }: { ws: Workspace }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded bg-raised px-1.5 ui-text-11.5 text-muted">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: colorHex(ws.color) }} />
      {ws.name}
    </span>
  );
}

function ProfileRow({ profile, account, folder, usedBy, onRename, onRemove }: { profile: ClaudeProfile | null; account: ProfileAccount | null | undefined; folder: string; usedBy: Workspace[]; onRename?: (name: string) => void; onRemove?: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [auth, setAuth] = useState<"in" | "out" | null>(null);
  const name = profile?.name ?? "Default";
  const signedIn = accountState(account) === "signed-in";
  const line = profileLine(
    account,
    usedBy.map((w) => w.name),
  );
  return (
    <div data-setting={`profile-${profile?.id ?? "default"}`} className="flex items-center gap-3.5 px-4 py-3.5">
      {profile ? (
        <Initial letter={name.trim().charAt(0).toUpperCase() || "?"} className="rounded-full" />
      ) : (
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised">
          <AgentIcon agent="claude" size={15} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {renaming && profile ? (
          <input
            autoFocus
            aria-label="Profile name"
            className={cx(fieldCls, "h-7")}
            defaultValue={profile.name}
            onBlur={(e) => {
              setRenaming(false);
              const next = e.target.value.trim();
              if (next && next !== profile.name) onRename?.(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="flex items-baseline gap-2 ui-text-13 font-medium">
            {name}
            <span className="font-mono ui-text-11.5 font-normal text-faint">{folder}</span>
          </span>
        )}
        <Status line={line} dot={line.tone === "blocked"} />
        {usedBy.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {usedBy.map((w) => (
              <WorkspaceChip key={w.id} ws={w} />
            ))}
          </span>
        )}
      </div>
      {signedIn ? (
        <Button size="sm" variant="ghost" onClick={() => setAuth("out")}>
          Sign out
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => setAuth("in")}>
          Sign in…
        </Button>
      )}
      {profile && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <IconButton title={`Remove ${name}`} onClick={onRemove}>
            <Trash2 size={13} />
          </IconButton>
        </>
      )}
      {auth && <ClaudeAuthDialog host="local" profile={profile} logout={auth === "out"} onClose={() => setAuth(null)} />}
    </div>
  );
}

function NewProfileForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const p = await rpc<ClaudeProfile>("local", M.profileCreate, { name: name.trim(), path: folder.trim() || null });
      void refreshProfile("local", p.id);
      toast(`Created ${p.name}`);
      onDone();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label="New profile"
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <span className="ui-text-13 font-medium">New profile</span>
      <div className="flex gap-2.5">
        <label className="flex flex-1 flex-col gap-1.5 ui-text-12 text-muted">
          Name
          <input autoFocus className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work profile" />
        </label>
        <label className="flex flex-1 flex-col gap-1.5 ui-text-12 text-muted">
          Folder
          <input className={cx(fieldCls, "font-mono")} spellCheck={false} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={defaultFolder(name || "work profile")} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
          Create profile
        </Button>
      </div>
    </form>
  );
}

export function ProfilesPage() {
  const profiles = useStore((s) => s.profiles.local);
  const defaultAccount = useStore((s) => s.defaultAccounts.local);
  const workspaces = useStore((s) => s.workspaces.local);
  const home = useStore((s) => s.hosts.local?.home ?? null);
  const [creating, setCreating] = useState(false);
  const usedBy = (id: string | null) => (workspaces ?? []).filter((w) => (w.claude_profile ?? null) === id);
  const remove = async (p: ClaudeProfile) => {
    if (!(await askConfirm({ title: "Remove profile", message: removeProfileConfirm({ ...p, account: null, hooks_installed: false }, workspaces ?? [], home), action: "Remove" }))) return;
    try {
      await rpc("local", M.profileDelete, { id: p.id });
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <>
      <PageHeading
        title="Profiles"
        aside={
          <Button disabled={creating} onClick={() => setCreating(true)}>
            <Plus size={13} /> New profile
          </Button>
        }
      >
        Each profile is a Claude Code config folder with its own sign-in, settings and MCP servers. A workspace picks one.
      </PageHeading>
      <Card>
        <ProfileRow profile={null} account={defaultAccount} folder="~/.claude" usedBy={usedBy(null)} />
        {(profiles ?? []).map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            account={p.account}
            folder={tildePath(p.path, home)}
            usedBy={usedBy(p.id)}
            onRename={(name) => void rpc("local", M.profileUpdate, { id: p.id, name }).catch(errorToast)}
            onRemove={() => void remove(p)}
          />
        ))}
      </Card>
      {creating && <NewProfileForm onDone={() => setCreating(false)} />}
      <p className="m-0 px-0.5 ui-text-12 text-muted">Profiles on this Mac. A workspace on a remote host picks from that host's profiles in its workspace settings.</p>
    </>
  );
}

export function HooksPage() {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const home = useStore((s) => s.hosts.local?.home ?? null);
  useEffect(() => {
    void rpc<HookStatus>("local", M.hooksStatus)
      .then(setStatus)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);
  const install = async () => {
    const ok = await askConfirm({
      title: "Install agent hooks",
      message: installHooksMessage(status),
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
  const done = hooksDone(status);
  return (
    <>
      <PageHeading title="Agent hooks">Hooks let Claude Code and Codex report exactly when they are working, waiting for approval, or done. The moonlet skill lets them open a session in another project.</PageHeading>
      <Card>
        {status &&
          hookRows(status, home).map((r) => (
            <div key={r.agent} data-setting={`hooks-${r.agent}`} className="flex items-start gap-3.5 px-4 py-3.5">
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised">
                <AgentIcon agent={r.agent} size={16} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2 ui-text-13 font-medium">
                  {r.name}
                  <span className={cx("inline-flex items-center gap-1 ui-text-12 font-normal", r.state.tone === "done" ? "text-done" : r.state.tone === "blocked" ? "text-blocked" : "text-muted")}>
                    {r.state.tone === "done" && <Check size={12} />}
                    {r.state.text}
                  </span>
                </span>
                <span className="font-mono ui-text-11.5 text-faint">{r.path}</span>
                {r.parts.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {r.parts.map((p) => (
                      <span key={p.label} className={cx("inline-flex h-5 items-center gap-1 rounded bg-raised px-1.5 ui-text-11.5", p.ok ? "text-muted" : "text-faint line-through")}>
                        {p.ok && <Check size={11} />}
                        {p.label}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          ))}
        {loadError && <div className="px-4 py-3 ui-text-12 text-blocked">Couldn't read which hooks are installed: {loadError}</div>}
        <div className="flex items-center gap-3 bg-panel-2 px-4 py-2.5">
          <span className="flex-1 ui-text-12 text-muted">A backup of each file is written first; your own settings are kept.</span>
          <Button size="sm" variant="primary" disabled={busy || done} onClick={() => void install()}>
            Install hooks
          </Button>
        </div>
      </Card>
      <div className="flex flex-col gap-1 rounded-[10px] border border-border px-3.5 py-3">
        <span className="ui-text-12.5 font-medium">Codex skipped?</span>
        <span className="ui-text-12 text-muted">
          Codex allows one notify command. When another tool already uses it, moonlet leaves it alone and shows which one here, e.g.{" "}
          <span className="font-mono text-fg">Skipped: already notifies "terminal-notifier"</span>.
        </span>
      </div>
    </>
  );
}
