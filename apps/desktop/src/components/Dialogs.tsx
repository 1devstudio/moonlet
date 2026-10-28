import { AddBoardDialog } from "./tasks/AddBoard";
import { JobLeftoverCompare, SyncCompare } from "./SyncCompare";
import { AddProjectDialog } from "./AddProject";
import { useEffect, useState } from "react";
import { rpc } from "../lib/daemon";
import { gitSettingsOf } from "../lib/gitSettings";
import { M, type Commit, type PullRequest } from "../lib/protocol";
import { errorToast, hostWorkspaces, refreshGit, selectedSession, shownWorkspace, toast, useStore } from "../lib/store";
import { taskWorkspace } from "../lib/boards";
import { Button, Dialog, Field, cx, inputCls } from "./ui";
import { Composer } from "./Composer";
import { newSectionWorkspace, wsKey } from "../lib/workspaces";
import { closesIssue, withCloses } from "../lib/keepInStep";
import { githubRepo } from "../lib/tasks";
import { rulesFor, trackersConfig, useTasks } from "../lib/tasksStore";
import { NewWorkspaceDialog } from "./WorkspaceDialogs";
import { NewDesignSystemDialog } from "./design/DesignMode";
import { NewDesignDialog } from "./design/NewDesignDialog";
import { LinkTaskDialog } from "./tasks/SessionTask";

const close = () => useStore.setState({ dialog: null });

export function NewSectionDialog() {
  const hosts = useStore((s) => s.hosts);
  const [name, setName] = useState("");
  const connected = Object.values(hosts).filter((h) => h.status === "connected");
  const [host, setHost] = useState(() => (connected.some((h) => h.id === "local") ? "local" : (connected[0]?.id ?? "local")));
  const create = async () => {
    try {
      const st = useStore.getState();
      const workspaceId = newSectionWorkspace(shownWorkspace(st), host, st.workspaces[host] ?? [], st.accounts[host]?.account ?? host);
      if (!workspaceId) return;
      await rpc(host, M.sectionCreate, { workspace_id: workspaceId, name });
      close();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <Dialog
      title="New section"
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
      <p className="mb-3 ui-text-12.5 text-muted">A section is a set of projects shown together in the sidebar, e.g. "1devstudio" or "Side projects".</p>
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
  const [all, setAll] = useState(() => gitSettingsOf(s.gitSettings, host).stage_all);
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
  const [draft, setDraft] = useState(() => gitSettingsOf(s.gitSettings, host).draft_prs);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ws) return;
    // The GitHub issue the session works on gets `Closes #N` (X46 Keep in step).
    const config = trackersConfig(useTasks.getState());
    // On the boards of whichever member holds them (X68).
    const board = ws.workspace_id ? taskWorkspace(host, ws.workspace_id, hostWorkspaces(useStore.getState()), config.boards, ws.task?.connection) : null;
    const tasks = board ? (useTasks.getState().data[wsKey(board.host, board.id)]?.tasks ?? []) : [];
    const issue = rpc<string | null>(host, M.gitOriginUrl, { path: ws.path })
      .then((url) => closesIssue(ws, githubRepo(url), tasks, config.link, (t) => rulesFor(config, t).pr_comment))
      .catch(() => null);
    void rpc<Commit[]>(host, M.gitLog, { path: ws.path, base: ws.base })
      .then(async (log) => {
        if (log.length === 1) setTitle(log[0].subject);
        setBody(withCloses(log.map((c) => `- ${c.subject}`).join("\n"), await issue));
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

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  switch (dialog?.kind) {
    case "add-project":
      return <AddProjectDialog host={dialog.host} section={dialog.section} clone={dialog.clone} />;
    case "new-section":
      return <NewSectionDialog />;
    case "new-workspace":
      return <NewWorkspaceDialog />;
    case "new-session":
      return <Composer host={dialog.host} project={dialog.project} workspace={dialog.workspace} task={dialog.task} worktree={dialog.worktree} design={dialog.design} />;
    case "link-task":
      return <LinkTaskDialog host={dialog.host} sessionId={dialog.session} />;
    case "add-board":
      return <AddBoardDialog host={dialog.host} workspace={dialog.workspace} boardId={dialog.board} connection={dialog.connection} build={dialog.build} />;
    case "commit":
      return <CommitDialog />;
    case "create-pr":
      return <CreatePrDialog />;
    case "new-design-system":
      return <NewDesignSystemDialog host={dialog.host} workspace={dialog.workspace} />;
    case "new-design":
      return <NewDesignDialog host={dialog.host} workspace={dialog.workspace} />;
    case "sync-compare":
      return <SyncCompare host={dialog.host} session={dialog.session} path={dialog.path} />;
    case "job-compare":
      return <JobLeftoverCompare host={dialog.host} session={dialog.session} path={dialog.path} folder={dialog.folder} />;
    default:
      return null;
  }
}
