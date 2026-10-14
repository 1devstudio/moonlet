// Settings › Workspaces › <name> (X43): name, colour and Claude profile
// (X32, X33), its sections, and Delete. Edits wait for Save in the bar.

import { useId, useMemo, useState } from "react";
import { rpc } from "../../lib/daemon";
import { M, type ClaudeProfile, type WorkspaceColor } from "../../lib/protocol";
import { askConfirm } from "../../lib/confirm";
import { errorToast, refreshProfile, toast, useStore } from "../../lib/store";
import { goSettings, setLeaveGuard } from "../../lib/settingsNavigation";
import { WORKSPACE_COLORS, deleteBlocked, sectionRows, workspaceDirty, workspaceSummary } from "../../lib/workspaces";
import { DEFAULT_PROFILE, NEW_PROFILE, accountLabel, accountState, defaultFolder, profileOptions, runningClaudeAgents, switchConfirm } from "../../lib/profiles";
import { ClaudeAuthDialog } from "../Profiles";
import { WorkspaceMark } from "../WorkspaceSwitcher";
import { Button, cx } from "../ui";
import { Card, PageBody, PageHeading, Row, SaveBar, Section, fieldCls, radioProps } from "./controls";
import { useUnsaved } from "./useUnsaved";

function Swatches({ value, onChange, labelledBy }: { value: WorkspaceColor; onChange: (c: WorkspaceColor) => void; labelledBy: string }) {
  const checked = WORKSPACE_COLORS.findIndex((c) => c.id === value);
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex gap-2.5">
      {WORKSPACE_COLORS.map((c, i) => (
        <button
          key={c.id}
          type="button"
          {...radioProps(i, checked, WORKSPACE_COLORS.length, (k) => onChange(WORKSPACE_COLORS[k].id))}
          aria-label={value === c.id ? `${c.label}, selected` : c.label}
          className="h-[22px] w-[22px] rounded-md"
          style={{ background: c.hex, boxShadow: value === c.id ? "0 0 0 2px var(--color-panel), 0 0 0 4px #e6e6e6" : undefined }}
        />
      ))}
    </div>
  );
}

/** The workspace's Claude profile, with its account and New profile…. */
function ProfileRows({ host, value, onChange }: { host: string; value: string; onChange: (v: string) => void }) {
  const profiles = useStore((s) => s.profiles[host]);
  const defaultAccount = useStore((s) => s.defaultAccounts[host]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [auth, setAuth] = useState(false);
  const picked = (profiles ?? []).find((p) => p.id === value) ?? null;
  const account = value === DEFAULT_PROFILE ? defaultAccount : picked?.account;
  const state = accountState(account);
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
    <>
      <Row setting="ws-profile" label="Profile" htmlFor="settings-ws-profile" hint="Every session in this workspace signs in with this account.">
        <select
          id="settings-ws-profile"
          aria-label="Claude profile"
          className={cx(fieldCls, "w-[260px]")}
          value={creating ? NEW_PROFILE : value}
          onChange={(e) => {
            if (e.target.value === NEW_PROFILE) setCreating(true);
            else {
              setCreating(false);
              onChange(e.target.value);
            }
          }}
        >
          {profileOptions(profiles ?? [], home).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      {creating ? (
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex gap-2.5">
            <input autoFocus className={cx(fieldCls, "flex-1")} value={name} onChange={(e) => setName(e.target.value)} placeholder="Profile name, e.g. Work profile" />
            <input className={cx(fieldCls, "flex-1 font-mono")} spellCheck={false} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`Folder (default ${defaultFolder(name)})`} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
              Create profile
            </Button>
          </div>
        </div>
      ) : (
        <div className={cx("flex items-center gap-2 px-4 py-2.5 ui-text-12", state === "signed-out" && "bg-[#1d1a12]")}>
          {state === "signed-out" && <span className="h-1.5 w-1.5 rounded-full bg-blocked" />}
          <span className={cx("flex-1", state === "signed-out" ? "text-blocked" : "text-muted")}>
            {state === "signed-in" && account ? `Signed in as ${accountLabel(account)}` : state === "signed-out" ? `${picked?.name ?? "Default"} is not signed in` : "Checking…"}
          </span>
          {state !== "signed-in" && (
            <Button size="sm" onClick={() => setAuth(true)}>
              Sign in…
            </Button>
          )}
          {host === "local" && (
            <button type="button" className="ui-text-12.5 text-accent-2 hover:text-accent" onClick={() => void goSettings({ page: "profiles" })}>
              Manage profiles
            </button>
          )}
          {auth && <ClaudeAuthDialog host={host} profile={picked} onClose={() => setAuth(false)} />}
        </div>
      )}
    </>
  );
}

export function WorkspacePage({ host, id }: { host: string; id: string }) {
  const ws = useStore((s) => s.workspaces[host]?.find((w) => w.id === id));
  const count = useStore((s) => (s.workspaces[host] ?? []).length);
  const sections = useStore((s) => s.sections[host]);
  const sessions = useStore((s) => s.sessions[host]);
  const terminals = useStore((s) => s.terminals[host]);
  const profiles = useStore((s) => s.profiles[host]);
  const remote = useStore((s) => (s.hosts[host]?.remote ? host : null));
  const [name, setName] = useState(ws?.name ?? "");
  const [color, setColor] = useState<WorkspaceColor>(ws?.color ?? "clay");
  const [profile, setProfile] = useState(ws?.claude_profile ?? DEFAULT_PROFILE);
  const [saving, setSaving] = useState(false);
  const colorId = useId();
  const runtime = useMemo(() => ({ sessions: sessions ?? [], terminals: Object.values(terminals ?? {}) }), [sessions, terminals]);
  const form = { name, color, profile };
  const dirty = !!ws && workspaceDirty(ws, form);
  const shown = name.trim() || ws?.name || "";
  const canSave = dirty && !!name.trim() && !saving;

  const discard = () => {
    if (!ws) return;
    setName(ws.name);
    setColor(ws.color);
    setProfile(ws.claude_profile ?? DEFAULT_PROFILE);
  };
  const save = async () => {
    if (!ws || !canSave) return;
    const ids = runtime.sessions.filter((x) => x.workspace_id === ws.id).map((x) => x.id);
    const message = switchConfirm(ws.claude_profile ?? null, profile || null, runningClaudeAgents(runtime.sessions, runtime.terminals, ids), profiles ?? []);
    if (message && !(await askConfirm({ title: "Change Claude profile", message, action: "Change profile" }))) return;
    setSaving(true);
    try {
      await rpc(host, M.workspaceUpdate, { id: ws.id, name: name.trim(), color, claude_profile: profile || null });
      setName(name.trim());
      toast(`Saved ${name.trim()}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setSaving(false);
    }
  };
  useUnsaved({ dirty, saving, message: `Discard unsaved changes to ${ws?.name ?? "this workspace"}?` }, () => void save());

  if (!ws)
    return (
      <PageBody>
        <PageHeading title="Workspace not found">It was deleted, or its host is not connected.</PageHeading>
      </PageBody>
    );

  const blocked = deleteBlocked(ws, count);
  const remove = async () => {
    if (!(await askConfirm({ title: "Delete workspace", message: `Delete ${ws.name}? It has no sections left, and its archived sessions move to another workspace.`, action: "Delete" }))) return;
    try {
      await rpc(host, M.workspaceDelete, { id: ws.id });
      setLeaveGuard(null);
      void goSettings({ page: "general" });
      toast(`Deleted ${ws.name}`);
    } catch (e) {
      errorToast(e);
    }
  };
  const rows = sectionRows(ws, sections ?? []);

  return (
    <PageBody
      bar={
        dirty && (
          <SaveBar dirty={dirty} canSave={canSave} onDiscard={discard} onSave={() => void save()}>
            <span className="flex items-center gap-2 ui-text-12.5 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Unsaved changes to {shown}
            </span>
          </SaveBar>
        )
      }
    >
      <PageHeading title={shown} icon={<WorkspaceMark name={shown} color={color} size={44} />}>
        {workspaceSummary(ws, remote, runtime.sessions)}
      </PageHeading>
      <Section title="Name and colour">
        <Card>
          <Row setting="ws-name" label="Name" htmlFor="settings-ws-name">
            <input id="settings-ws-name" className={cx(fieldCls, "w-[260px]")} value={name} placeholder="Acme" aria-invalid={!name.trim()} onChange={(e) => setName(e.target.value)} />
          </Row>
          <Row setting="ws-color" label="Colour" labelId={colorId}>
            <Swatches value={color} onChange={setColor} labelledBy={colorId} />
          </Row>
        </Card>
      </Section>
      <Section title="Claude profile">
        <Card>
          <ProfileRows host={host} value={profile} onChange={setProfile} />
        </Card>
      </Section>
      <Section title="Sections" hint="Rename, reorder and add sections in the sidebar.">
        <Card>
          {rows.length ? (
            rows.map((r) => (
              <div key={r.id} className="flex items-center px-4 py-3 ui-text-13">
                <span className="flex-1 truncate">{r.name}</span>
                <span className="ui-text-12 text-faint">{r.projects}</span>
              </div>
            ))
          ) : (
            <div className="px-4 py-3 ui-text-12.5 text-muted">No sections.</div>
          )}
        </Card>
      </Section>
      <Section title="Delete">
        <Card danger>
          <Row setting="ws-delete" label="Delete workspace" hint={blocked ?? "Its archived sessions move to another workspace."}>
            <span title={blocked ?? undefined}>
              <Button size="sm" variant="danger" disabled={!!blocked} onClick={() => void remove()}>
                Delete workspace
              </Button>
            </span>
          </Row>
        </Card>
      </Section>
    </PageBody>
  );
}
