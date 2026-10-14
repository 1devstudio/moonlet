// New workspace (X32), with the Claude profile its sessions sign in with
// (X33). Workspace settings are a settings page (settings/WorkspacePage).

import { useMemo, useState } from "react";
import { rpc } from "../lib/daemon";
import { M, type Workspace, type WorkspaceColor } from "../lib/protocol";
import { askConfirm } from "../lib/confirm";
import { workspaceSections } from "../lib/sidebar";
import { errorToast, shownWorkspace, switchWorkspace, useStore } from "../lib/store";
import { WORKSPACE_COLORS, count, createRequest } from "../lib/workspaces";
import { DEFAULT_PROFILE, movingSessions, runningClaudeAgents, switchConfirm } from "../lib/profiles";
import { WorkspaceMark } from "./WorkspaceSwitcher";
import { ProfileField } from "./Profiles";
import { Button, Dialog, Field, cx, inputCls } from "./ui";

/** The sessions and terminals of a host, for counting running Claude agents. */
function useHostRuntime(host: string | undefined) {
  const sessions = useStore((s) => (host ? s.sessions[host] : undefined));
  const terminals = useStore((s) => (host ? s.terminals[host] : undefined));
  return useMemo(() => ({ sessions: sessions ?? [], terminals: Object.values(terminals ?? {}) }), [sessions, terminals]);
}

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
        <input autoFocus className={inputCls} value={name} onChange={(e) => onChange(e.target.value)} placeholder="Acme" onKeyDown={(e) => e.key === "Enter" && onEnter()} />
      </label>
    </div>
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
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const profiles = useStore((s) => (from ? s.profiles[from.host] : undefined));
  const runtime = useHostRuntime(from?.host);
  const req = createRequest({ name, color, start, moving });
  const create = async () => {
    if (!req || !from || !fromWs) return;
    // Sessions moving with their sections sign in with the new workspace's profile.
    const ids = req.move_sections.flatMap((id) => movingSessions(fromWs, hostSections ?? [], runtime.sessions, id));
    const message = switchConfirm(fromWs.claude_profile ?? null, profile || null, runningClaudeAgents(runtime.sessions, runtime.terminals, ids), profiles ?? []);
    if (message && !(await askConfirm({ title: "Change Claude profile", message, action: "Create workspace" }))) return;
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
