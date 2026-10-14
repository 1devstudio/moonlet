// Claude profiles in the app (X33): the profile select, signing in and out,
// and the sidebar footer. Settings › Profiles is in settings/ClaudePages.

import { useEffect, useRef, useState } from "react";
import { User } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type ClaudeProfile, type ProfileAccount, type TerminalInfo } from "../lib/protocol";
import { errorToast, refreshProfile, shownWorkspace, useStore } from "../lib/store";
import { goSettings } from "../lib/settingsNavigation";
import { DEFAULT_PROFILE, NEW_PROFILE, accountLabel, accountState, defaultFolder, footerLabel, profileOptions } from "../lib/profiles";
import { TerminalPane } from "./TerminalPane";
import { Button, Dialog, Field, cx, inputCls } from "./ui";

type AuthAction = "login" | "login-console" | "logout";

const AUTH_ARGS: Record<AuthAction, string[]> = {
  login: ["auth", "login"],
  "login-console": ["auth", "login", "--console"],
  logout: ["auth", "logout"],
};

/** Runs `claude auth …` for a profile (`null`: the default) in a terminal,
 * then asks the daemon who it is signed in as. Signing in first asks how. */
export function ClaudeAuthDialog({ host, profile, logout, onClose }: { host: string; profile: ClaudeProfile | null; logout?: boolean; onClose: () => void }) {
  const [action, setAction] = useState<AuthAction | null>(logout ? "logout" : null);
  const [term, setTerm] = useState<number | null>(null);
  const exit = useStore((s) => (term !== null ? s.terminals[host]?.[term]?.exit : undefined));
  // One run per chosen action, whatever the parent re-renders.
  const done = useRef(onClose);
  done.current = onClose;
  useEffect(() => {
    if (!action) return;
    let cancelled = false;
    let id: number | null = null;
    void rpc<TerminalInfo>(host, M.terminalCreate, {
      cwd: profile?.path ?? "",
      command: ["claude", ...AUTH_ARGS[action]],
      env: profile ? { CLAUDE_CONFIG_DIR: profile.path } : {},
      kind: "run",
      title: `claude ${AUTH_ARGS[action].join(" ")}`,
      cols: 100,
      rows: 24,
    })
      .then((t) => {
        // Closed before the terminal came back: stop it at once.
        if (cancelled) void rpc(host, M.terminalKill, { id: t.id, remove: true }).catch(() => {});
        else {
          id = t.id;
          setTerm(t.id);
        }
      })
      .catch((e) => {
        errorToast(e);
        done.current();
      });
    return () => {
      cancelled = true;
      if (id !== null) void rpc(host, M.terminalKill, { id, remove: true }).catch(() => {});
      void refreshProfile(host, profile?.id ?? null);
    };
  }, [host, profile?.id, profile?.path, action]);
  // A success closes the window; a failure stays, so its output can be read.
  useEffect(() => {
    if (exit && exit.code === 0) done.current();
  }, [exit]);
  const name = profile?.name ?? "Default profile";
  return (
    <Dialog title={logout ? `Sign out: ${name}` : `Sign in: ${name}`} width={720} onClose={onClose}>
      {!action ? (
        <div className="flex flex-col gap-2">
          <p className="ui-text-12 text-muted">How should Claude Code in this profile be billed?</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => setAction("login")}>
              Claude subscription
            </Button>
            <Button onClick={() => setAction("login-console")}>Anthropic Console (API billing)</Button>
          </div>
        </div>
      ) : (
        <>
          <p className={cx("mb-2 ui-text-12", exit && exit.code !== 0 ? "text-error" : "text-muted")}>
            {exit && exit.code !== 0
              ? `Claude Code stopped with exit code ${exit.code ?? exit.signal}. Its output is below.`
              : logout
                ? "Signing out…"
                : "Finish signing in in your browser. This window closes when Claude Code is done."}
          </p>
          <div className="h-[340px] overflow-hidden rounded-md border border-border bg-bg">{term !== null && <TerminalPane host={host} session={term} wsId="" focused visible />}</div>
        </>
      )}
    </Dialog>
  );
}

/** "Signed in as …" / "Not signed in" with Sign in…, for a profile or the default. */
function AccountLine({ host, profile, account }: { host: string; profile: ClaudeProfile | null; account: ProfileAccount | null | undefined }) {
  const [auth, setAuth] = useState(false);
  const state = accountState(account);
  return (
    <div className="mt-1.5 flex items-center gap-2 ui-text-12">
      {state === "signed-in" && account ? (
        <span className="text-muted">Signed in as {accountLabel(account)}</span>
      ) : (
        <>
          <span className={state === "signed-out" ? "text-blocked" : "text-faint"}>{state === "signed-out" ? "Not signed in" : "Checking…"}</span>
          <Button size="sm" onClick={() => setAuth(true)}>
            Sign in…
          </Button>
        </>
      )}
      {auth && <ClaudeAuthDialog host={host} profile={profile} onClose={() => setAuth(false)} />}
    </div>
  );
}

/** The Claude profile select (X33): the default, every profile, New profile…. */
export function ProfileField({ host, value, onChange }: { host: string; value: string; onChange: (v: string) => void }) {
  const profiles = useStore((s) => s.profiles[host]);
  const defaultAccount = useStore((s) => s.defaultAccounts[host]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
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
        value={creating ? NEW_PROFILE : value}
        onChange={(e) => {
          if (e.target.value === NEW_PROFILE) setCreating(true);
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
          <input className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`Folder (default ${defaultFolder(name)})`} />
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
      {!creating && (value === DEFAULT_PROFILE ? <AccountLine host={host} profile={null} account={defaultAccount} /> : picked && <AccountLine host={host} profile={picked} account={picked.account} />)}
    </Field>
  );
}

/** The sidebar footer: the account the shown workspace's agents use (X33). */
export function ProfileFooter() {
  const shown = useStore((s) => shownWorkspace(s));
  const ws = useStore((s) => (shown ? s.workspaces[shown.host]?.find((w) => w.id === shown.id) : undefined));
  const profiles = useStore((s) => (shown ? s.profiles[shown.host] : undefined));
  const defaultAccount = useStore((s) => (shown ? (s.defaultAccounts[shown.host] ?? null) : null));
  const home = useStore((s) => (shown ? (s.hosts[shown.host]?.home ?? null) : null));
  if (!shown || !ws) return null;
  const f = footerLabel(ws, profiles ?? [], home, defaultAccount);
  return (
    <button
      title={f.title}
      onClick={() => void goSettings({ page: "workspace", host: shown.host, id: ws.id })}
      className={cx("flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 ui-text-11.5 hover:bg-panel-2", f.warn ? "text-blocked" : "text-faint hover:text-muted")}
    >
      <User size={12} className="shrink-0" />
      <span className="truncate">{f.text}</span>
    </button>
  );
}
