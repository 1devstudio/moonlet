// A session's long-press sheet and a section's ⋯ sheet in Sessions (X118):
// the desktop sidebar's menus, as bottom sheets.

import { type ReactNode, useState } from "react";
import { Archive, ArrowUpToLine, Check, ChevronLeft, ChevronRight, CornerDownRight, ExternalLink, FolderInput, GitFork, Link2, Pencil, Pin, PinOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rpc } from "@desktop/lib/daemon";
import type { PullRequest, Section, Session } from "@desktop/lib/protocol";
import { moveUnderTargets } from "@desktop/lib/sidebar";
import { moveTargets } from "@desktop/lib/sessionPick";
import { showScreen, useApp } from "../lib/app";
import { forget } from "../lib/rowDetails";
import { rowTarget, type SessionRow } from "../lib/sessionList";
import { actionCall, menuItems, type SessionAction, type ViewChoice, viewCall } from "../lib/sessionActions";
import { sessionHost } from "../lib/copies";
import { useBusy } from "../lib/busy";
import { ArchiveSheet } from "../screens/Session";
import { LinkSheet } from "./LinkSheet";
import { Sheet } from "./Sheet";
import { Btn, cx } from "./ui";

function Item({ icon, label, onClick, danger, checked, more, disabled, hint }: { icon?: ReactNode; label: string; onClick?: () => void; danger?: boolean; checked?: boolean; more?: boolean; disabled?: boolean; hint?: string | null }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cx("flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] disabled:opacity-40", danger && "text-error")}>
      <span className="flex w-5 justify-center text-muted">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className="truncate text-[12.5px] text-faint">{hint}</span>}
      </span>
      {checked && <Check size={17} className="flex-none text-accent" />}
      {more && <ChevronRight size={17} className="flex-none text-faint" />}
    </button>
  );
}

const Divider = () => <div className="mx-4 my-1 h-px bg-border" />;

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      {onBack ? (
        <button type="button" aria-label="Back" onClick={onBack} className="flex h-10 w-10 items-center justify-center text-muted">
          <ChevronLeft size={20} />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <span className="min-w-0 flex-1 truncate text-[16px] font-semibold">{title}</span>
    </div>
  );
}

type Page = "menu" | "rename" | "move-workspace" | "move-under" | "link" | "archive";

/** A session's long-press sheet (X118): the desktop's menu items the phone can do. */
export function SessionSheet({ r, pr, onClose }: { r: SessionRow; pr: PullRequest | null | undefined; onClose: () => void }) {
  const s = r.session;
  const d = useApp((st) => st.data[r.host]);
  const [page, setPage] = useState<Page>("menu");
  const [name, setName] = useState(s.name);
  const { busy, error, run } = useBusy();
  const linked = !!s.task;
  const sources = !!(s.workspace_id && d?.tasks[s.workspace_id]?.boards.length);
  const items = menuItems(s, { linked, sources, pr: !!pr?.url });
  // A change to another member's session goes through its central host (X72).
  const host = sessionHost(r.host, s);
  const act = (a: SessionAction) =>
    run(async () => {
      const call = actionCall(s, a);
      if (!call) return onClose();
      const out = await rpc<Session>(host, call.method, call.params);
      forget(`git:${r.host}:${s.id}`);
      onClose();
      if (a.kind === "fork") showScreen({ kind: "session", host, id: out.id, tab: "chat" });
    });
  if (page === "link") return <LinkSheet host={r.host} session={s} onClose={onClose} />;
  if (page === "archive") return <ArchiveSheet host={host} session={s} pr={pr} onClose={onClose} />;
  if (page === "rename") {
    return (
      <Sheet label="Rename session" onClose={onClose}>
        <Header title="Rename" onBack={() => setPage("menu")} />
        <div className="flex flex-col gap-3 px-4 pb-2">
          <input autoFocus aria-label="Session name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void act({ kind: "rename", name })} className="h-11 rounded-[10px] border border-border-strong bg-raised px-3 text-[15px] outline-none" />
          {error && <span className="text-[12.5px] text-error">{error}</span>}
          <Btn tone="primary" disabled={busy || !name.trim()} onClick={() => void act({ kind: "rename", name })}>
            Rename
          </Btn>
        </div>
      </Sheet>
    );
  }
  if (page === "move-workspace") {
    const places = d ? [{ host: r.host, workspaces: d.workspaces, sections: d.sections, projects: d.projects, profiles: [] }] : [];
    const { disabled, targets } = moveTargets([{ host: r.host, ws: s }], places);
    return (
      <Sheet label="Move to workspace" onClose={onClose}>
        <Header title="Move to workspace" onBack={() => setPage("menu")} />
        <div className="scroll flex flex-col pb-2">
          {disabled && <p className="px-4 text-[14px] text-muted">{disabled}</p>}
          {targets.map((t) => (
            <Item key={t.id} label={t.name} checked={t.current} disabled={busy || !!t.disabled || t.current} hint={t.disabled ?? t.note} onClick={() => void act({ kind: "move-workspace", workspace: t.id })} />
          ))}
          {error && <span className="px-4 text-[12.5px] text-error">{error}</span>}
        </div>
      </Sheet>
    );
  }
  if (page === "move-under") {
    const t = moveUnderTargets(s, d?.sessions ?? []);
    return (
      <Sheet label="Move under" onClose={onClose}>
        <Header title="Move under" onBack={() => setPage("menu")} />
        <div className="scroll flex flex-col pb-2">
          {t.disabled && <p className="px-4 text-[14px] text-muted">{t.disabled}</p>}
          {t.top && <Item icon={<ArrowUpToLine size={17} />} label="Move to top level" disabled={busy} onClick={() => void act({ kind: "move-under", parent: null })} />}
          {t.top && t.targets.length > 0 && <Divider />}
          {t.targets.map((x) => (
            <Item key={x.id} label={x.name} checked={x.current} disabled={busy || x.current} onClick={() => void act({ kind: "move-under", parent: x.id })} />
          ))}
          {error && <span className="px-4 text-[12.5px] text-error">{error}</span>}
        </div>
      </Sheet>
    );
  }
  const icon = (I: typeof Archive) => <I size={17} />;
  return (
    <Sheet label={s.name} onClose={onClose}>
      <Header title={s.name} />
      <div className="scroll flex flex-col pb-2">
        {items.map((id, i) => {
          switch (id) {
            case "-":
              return <Divider key={i} />;
            case "open":
              return <Item key={id} label="Open" onClick={() => (onClose(), showScreen(rowTarget(r)))} />;
            case "open-pr":
              return <Item key={id} icon={icon(ExternalLink)} label="Open PR" onClick={() => void openUrl(pr!.url).catch(() => {})} />;
            case "pin-top":
              return <Item key={id} icon={icon(Pin)} label="Pin to top" disabled={busy} onClick={() => void act({ kind: "pin-top" })} />;
            case "unpin-top":
              return <Item key={id} icon={icon(PinOff)} label="Unpin from top" disabled={busy} onClick={() => void act({ kind: "unpin-top" })} />;
            case "rename":
              return <Item key={id} icon={icon(Pencil)} label="Rename" onClick={() => setPage("rename")} />;
            case "fork":
              return <Item key={id} icon={icon(GitFork)} label={busy ? "Forking…" : "Fork"} disabled={busy} onClick={() => void act({ kind: "fork" })} />;
            case "move-workspace":
              return <Item key={id} icon={icon(FolderInput)} label="Move to workspace" more onClick={() => setPage("move-workspace")} />;
            case "move-under":
              return <Item key={id} icon={icon(CornerDownRight)} label="Move under" more onClick={() => setPage("move-under")} />;
            case "link-task":
              return <Item key={id} icon={icon(Link2)} label="Link to task…" onClick={() => setPage("link")} />;
            case "archive":
              return <Item key={id} icon={icon(Archive)} label="Archive" danger onClick={() => setPage("archive")} />;
            default:
              return null;
          }
        })}
        {error && <span className="px-4 text-[12.5px] text-error">{error}</span>}
      </div>
    </Sheet>
  );
}

const GROUP_BY = [
  ["project", "Project"],
  ["task", "Task"],
  ["status", "Status"],
  ["none", "None"],
] as const;
const SORT_BY = [
  ["recent", "Recent activity"],
  ["created", "Created"],
  ["name", "Name"],
] as const;

/** A section's ⋯ sheet (X118): Group by, Filter by project and Sort by, saved on the section's host. */
export function SectionSheet({ host, sec, onClose }: { host: string; sec: Section; onClose: () => void }) {
  const projects = useApp((s) => s.data[host]?.projects ?? []);
  const { busy, error, run } = useBusy();
  const v = sec.view;
  const pick = (c: ViewChoice) =>
    run(async () => {
      const call = viewCall(sec, c);
      await rpc(host, call.method, call.params);
    });
  const label = (t: string) => <div className="eyebrow px-4 pt-2 pb-1">{t}</div>;
  return (
    <Sheet label={sec.name} onClose={onClose}>
      <Header title={sec.name} />
      <div className="scroll flex flex-col pb-2">
        {label("Group by")}
        {GROUP_BY.map(([id, name]) => (
          <Item key={id} label={name} checked={v.group_by === id} disabled={busy} onClick={() => void pick({ group_by: id })} />
        ))}
        {label("Filter by project")}
        {sec.project_ids.flatMap((id) => {
          const p = projects.find((x) => x.id === id);
          return p ? [<Item key={id} label={p.name} checked={v.filter.length === 0 || v.filter.includes(id)} disabled={busy} onClick={() => void pick({ toggle: id })} />] : [];
        })}
        {label("Sort by")}
        {SORT_BY.map(([id, name]) => (
          <Item key={id} label={name} checked={v.sort_by === id} disabled={busy} onClick={() => void pick({ sort_by: id })} />
        ))}
        {error && <span className="px-4 text-[12.5px] text-error">{error}</span>}
      </div>
    </Sheet>
  );
}
