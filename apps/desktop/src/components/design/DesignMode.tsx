// Design mode (X65): the sidebar's design systems and designs, the main area,
// and the New design system dialog (X64).

import { Command, Lock, Plus, SwatchBook } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorToast, shownWorkspace, toast, useStore } from "../../lib/store";
import { type DesignCover, type DesignSystem } from "../../lib/protocol";
import { systemFolder, systemLabel, type RowLabel } from "../../lib/design";
import { createSystem, detectStack, loadSystems, shownSystem, showSystem, systemsOf, useDesign } from "../../lib/designStore";
import { workspaceProjects } from "../../lib/tasksStore";
import { tildePath } from "../../lib/profiles";
import { useNow } from "../../lib/useNow";
import { cx } from "../../lib/cx";
import { AgentIcon, Button, Dialog, Field, IconButton, Kbd, inputCls } from "../ui";
import { ProjectMark } from "../Sidebar";
import { AgentView } from "../AgentView";

/** The shown workspace and its design systems, listed when it is shown. */
function useWorkspaceSystems() {
  const ws = useStore((s) => shownWorkspace(s));
  const systems = useDesign((d) => (ws ? systemsOf(d, ws.host, ws.id) : undefined));
  const shown = useDesign((d) => (ws ? shownSystem(d, ws.host, ws.id) : null));
  useEffect(() => {
    if (ws) void loadSystems(ws.host, ws.id).catch(errorToast);
  }, [ws]);
  return { ws, systems, shown };
}

const openNewSystem = (ws: { host: string; id: string } | null) => ws && useStore.setState({ dialog: { kind: "new-design-system", host: ws.host, workspace: ws.id } });

const TONES: Record<RowLabel["tone"], string> = { attention: "text-blocked", changed: "text-accent", error: "text-error", muted: "text-faint" };

function Heading({ label, add }: { label: string; add?: { title: string; run: () => void } }) {
  return (
    <div className="mx-2 mt-3 flex h-7 items-center px-2">
      <span className="flex-1 ui-text-11.5 uppercase tracking-[0.08em] text-faint">{label}</span>
      {add && (
        <IconButton title={add.title} onClick={add.run}>
          <Plus size={12} />
        </IconButton>
      )}
    </div>
  );
}

/** The sidebar body in Design mode. */
export function DesignSidebar() {
  const { ws, systems, shown } = useWorkspaceSystems();
  const now = useNow(true);
  const row = "flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left ui-text-14";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="px-2">
        {/* Designs come with a design system to start from (X65 entry 7). */}
        <button disabled title="A design starts from a design system" className={cx(row, "text-muted opacity-60")}>
          <span className="flex w-4 justify-center">
            <Plus size={15} strokeWidth={1.75} />
          </span>
          <span className="flex-1">New design</span>
        </button>
        <button className={cx(row, "no-drag text-muted hover:bg-panel-2 hover:text-fg")} onClick={() => useStore.setState({ dialog: { kind: "palette" } })}>
          <span className="flex w-4 justify-center">
            <Command size={15} strokeWidth={1.75} />
          </span>
          <span className="flex-1">Run action</span>
          <Kbd>⌘K</Kbd>
        </button>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <Heading label="Design systems" add={{ title: "New design system", run: () => openNewSystem(ws) }} />
        <nav aria-label="Design systems" className="px-2">
          {systems?.length === 0 && <p className="px-2 py-1 ui-text-12.5 text-faint">None yet. Build one from a project's code.</p>}
          {systems?.map((sys) => {
            const label = systemLabel(sys, now);
            const current = sys.slug === shown?.slug;
            return (
              <button
                key={sys.slug}
                aria-current={current ? "page" : undefined}
                onClick={() => ws && showSystem(ws.host, ws.id, sys.slug)}
                className={cx("relative flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left ui-text-13 text-fg", current ? "bg-selected" : "hover:bg-panel-2")}
              >
                {current && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                <SwatchBook size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{sys.name}</span>
                <span title={sys.error ?? sys.needs_you?.text} className={cx("shrink-0 ui-text-11.5 tabular-nums", TONES[label.tone])}>
                  {label.text}
                </span>
              </button>
            );
          })}
        </nav>
        <Heading label="Designs" />
        <p className="mx-2 px-2 py-1 ui-text-12.5 text-faint">{systems?.length ? "No designs yet." : "A design starts from a design system."}</p>
      </div>
    </div>
  );
}

/** The main area in Design mode: the open design system, or how to start. */
export function DesignMain() {
  const { ws, systems, shown } = useWorkspaceSystems();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const now = useNow(true);
  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="drag h-[52px] shrink-0 border-b border-border bg-panel" style={{ paddingLeft: sidebarOpen ? 0 : 84 }} />
      {shown && ws ? (
        <SystemSummary key={shown.slug} host={ws.host} sys={shown} label={systemLabel(shown, now)} />
      ) : systems?.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <SwatchBook size={18} className="text-muted" />
          <div className="ui-text-14 font-semibold text-fg">No design system yet</div>
          <p className="max-w-md ui-text-13 text-muted">
            Build one from a project's code. An agent reads the project and writes its tokens, components and screens as plain HTML. Every design in this workspace can then use it.
          </p>
          <Button variant="primary" onClick={() => openNewSystem(ws)}>
            <Plus size={14} /> New design system
          </Button>
          <ol className="mt-8 grid grid-cols-3 gap-2.5 text-left">
            {STARTS.map(([title, text], i) => (
              <li key={title} className="w-[180px] rounded-lg border border-border bg-panel p-3.5">
                <div className={cx("ui-text-11.5", i === 0 ? "text-accent" : "text-faint")}>{i + 1}</div>
                <div className="mt-1.5 ui-text-13 font-medium text-fg">{title}</div>
                <div className="mt-1.5 ui-text-12 text-muted">{text}</div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

const STARTS = [
  ["Design system", "From one or more projects. Kept in sync as the code moves."],
  ["Design", "A brief, then pages you shape with Claude, comments and edits."],
  ["Build it", "A session in the project, with the pages attached."],
] as const;

/** What a design system is, until the design system view (X64, entry 5c),
 * with its sync agent's chat docked on the right: its questions and
 * approvals are answered there. */
function SystemSummary({ host, sys, label }: { host: string; sys: DesignSystem; label: RowLabel }) {
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const agent = useStore((s) => (sys.agent !== null && s.terminals[host]?.[sys.agent]?.chat ? sys.agent : null));
  const [hidden, setHidden] = useState(false);
  return (
    <div className="flex min-h-0 flex-1">
    <div className="min-w-0 flex-1 p-6">
      <div className="flex items-center gap-2.5">
        <SwatchBook size={16} className="text-muted" />
        <h1 className="ui-text-15 font-semibold text-fg">{sys.name}</h1>
        <span className={cx("ui-text-12", TONES[label.tone])}>{label.text}</span>
        {agent !== null && hidden && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setHidden(false)}>
            Show agent
          </Button>
        )}
      </div>
      <p className="mt-2 ui-text-12.5 text-muted">
        {sys.cards} cards · {sys.layouts} layouts · from {sys.sources.map((p) => tildePath(p, home)).join(", ")}
      </p>
      {sys.needs_you && <p className="mt-2 ui-text-12.5 text-blocked">Claude {sys.needs_you.kind === "question" ? "asks" : "needs your approval"}: {sys.needs_you.text}</p>}
      {sys.step && (
        <p className="mt-2 ui-text-12.5 text-muted">
          {sys.step[0].toUpperCase() + sys.step.slice(1)}
          {sys.step_summary && ` · ${sys.step_summary}`}
        </p>
      )}
      {sys.error && <p className="mt-2 ui-text-12.5 text-error">{sys.error}</p>}
    </div>
      {agent !== null && !hidden && (
        <section aria-label={`Design · ${sys.name}`} className="flex w-[440px] shrink-0 flex-col border-l border-border">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 ui-text-12.5">
            <AgentIcon agent="claude" size={13} />
            <span className="min-w-0 flex-1 truncate text-muted">Writes only in systems/{sys.slug}</span>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
              Hide agent
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <AgentView host={host} id={agent} wsId="" focused visible />
          </div>
        </section>
      )}
    </div>
  );
}

const COVERS: { value: DesignCover; label: string; hint: string }[] = [
  { value: "core", label: "What matters most", hint: "the 20 to 40 components used most" },
  { value: "all", label: "Everything", hint: "every component" },
  { value: "none", label: "None yet", hint: "placeholder cards to fill later" },
];

const STEPS = [
  ["Inventory", "components"],
  ["Tokens", "tokens.css"],
  ["Cards", "one per component"],
  ["Layouts", "whole screens"],
] as const;

/** New design system (X64 journey step 1): a name, the projects it is built from, and what to cover. */
export function NewDesignSystemDialog({ host, workspace }: { host: string; workspace: string }) {
  const projects = useStore(useShallow((s) => workspaceProjects(s, host, workspace)));
  const home = useStore((s) => s.hosts[host]?.home ?? null);
  const taken = useDesign((d) => systemsOf(d, host, workspace))?.map((s) => s.slug);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(() => (projects[0] ? [projects[0].id] : []));
  const [cover, setCover] = useState<DesignCover>("core");
  const [stacks, setStacks] = useState<Record<string, string>>({});
  const [building, setBuilding] = useState(false);
  const close = () => useStore.setState({ dialog: null });
  const paths = useMemo(() => projects.map((p) => p.path), [projects]);

  useEffect(() => {
    let live = true;
    for (const path of paths) void detectStack(host, workspace, path).then((stack) => live && setStacks((s) => ({ ...s, [path]: stack })));
    return () => {
      live = false;
    };
  }, [host, workspace, paths]);

  const ready = !!name.trim() && picked.length > 0 && !building;
  const build = async () => {
    if (!ready) return;
    setBuilding(true);
    try {
      const made = await createSystem(host, workspace, { name: name.trim(), projects: picked, cover });
      showSystem(host, workspace, made.slug);
      close();
      if (made.agent_error) toast(`${name.trim()} was made, but its agent did not start: ${made.agent_error}`, "error");
    } catch (e) {
      errorToast(e);
      setBuilding(false);
    }
  };

  return (
    <Dialog
      title="New design system"
      width={540}
      onClose={close}
      footer={
        <>
          <span className="mr-auto self-center ui-text-12 text-faint">Open agent shows its chat while it works</span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void build()}>
            Build design system
          </Button>
        </>
      }
    >
      <Field label="Name" hint={<span className="font-mono">{systemFolder(workspace, name, taken ?? [])}</span>}>
        <input autoFocus className={inputCls} value={name} placeholder="moonlet desktop" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void build()} />
      </Field>
      <div className="mb-1 ui-text-11.5 font-medium text-muted">Built from the code of</div>
      <div role="group" aria-label="Built from the code of" className="overflow-hidden rounded-md border border-border">
        {projects.length === 0 && <p className="px-3 py-2.5 ui-text-12.5 text-faint">This workspace has no projects yet.</p>}
        {projects.map((p) => {
          const on = picked.includes(p.id);
          return (
            <label key={p.id} className={cx("flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0", on ? "bg-selected" : "hover:bg-panel-2")}>
              <input type="checkbox" className="accent-[var(--color-accent)]" checked={on} onChange={() => setPicked((ps) => (on ? ps.filter((x) => x !== p.id) : [...ps, p.id]))} />
              <ProjectMark host={host} projectId={p.id} />
              <span className="min-w-0 flex-1">
                <span className="block truncate ui-text-13 text-fg">{p.name}</span>
                <span className="block truncate font-mono ui-text-11 text-faint">
                  {tildePath(p.path, home)} · {p.base_branch}
                </span>
              </span>
              <span className="shrink-0 ui-text-12 text-muted">{stacks[p.path] ?? ""}</span>
            </label>
          );
        })}
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 ui-text-12 text-faint">
        <Lock size={11} /> Read only. The agent writes nothing in these projects.
      </p>
      <div className="mt-4 mb-1 ui-text-11.5 font-medium text-muted">What to cover</div>
      <div role="radiogroup" aria-label="What to cover" className="grid grid-cols-3 gap-1.5">
        {COVERS.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={cover === c.value}
            onClick={() => setCover(c.value)}
            className={cx("rounded-md border px-2.5 py-2 text-left", cover === c.value ? "border-accent bg-selected" : "border-border hover:bg-panel-2")}
          >
            <span className="block ui-text-12.5 text-fg">{c.label}</span>
            <span className="block ui-text-11.5 text-faint">{c.hint}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 ui-text-12.5 text-fg">
          <AgentIcon agent="claude" size={13} /> Claude Code builds it in four steps, checking each one
        </div>
        <ol className="mt-2.5 grid grid-cols-4 gap-1.5">
          {STEPS.map(([step, makes]) => (
            <li key={step} className="rounded-md bg-panel-2 px-2.5 py-2">
              <span className="block ui-text-12 text-fg">{step}</span>
              <span className="block ui-text-11.5 text-faint">{makes}</span>
            </li>
          ))}
        </ol>
      </div>
    </Dialog>
  );
}
