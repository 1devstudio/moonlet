// Design mode (X65): the sidebar's design systems and designs, the main area
// (a design system's view or a design's screen), and the New design system
// dialog (X64).

import { Command, Lock, MessageSquare, Plus, SwatchBook } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorToast, shownWorkspace, toast, useStore } from "../../lib/store";
import { type DesignCover } from "../../lib/protocol";
import { designAgentState, designRow, designsEmpty, picksInWorkspace, systemFolder, systemLabel } from "../../lib/design";
import { createSystem, designsOf, openNewDesign, detectStack, loadDesigns, loadSystems, shownDesign, shownSystem, showDesign, showSystem, systemsOf, useDesign } from "../../lib/designStore";
import { workspaceProjects } from "../../lib/tasksStore";
import { tildePath } from "../../lib/profiles";
import { useNow } from "../../lib/useNow";
import { cx } from "../../lib/cx";
import { AgentIcon, Button, Dialog, Field, IconButton, Kbd, StateGlyph, inputCls } from "../ui";
import { ProjectMark } from "../Sidebar";
import { DesignSystemView, TONES } from "./SystemView";
import { DesignScreen } from "./DesignScreen";

/** The shown workspace, its design systems and designs, and the ones shown;
 * `load` lists them when the workspace is shown (the sidebar does, so a
 * failure shows once). */
function useWorkspaceDesign(load = false) {
  const ws = useStore((s) => shownWorkspace(s));
  const systems = useDesign((d) => (ws ? systemsOf(d, ws.host, ws.id) : undefined));
  const shown = useDesign((d) => (ws ? shownSystem(d, ws.host, ws.id) : null));
  const designs = useDesign((d) => (ws ? designsOf(d, ws.host, ws.id) : undefined));
  const design = useDesign((d) => (ws ? shownDesign(d, ws.host, ws.id) : null));
  useEffect(() => {
    if (ws && load) {
      void loadSystems(ws.host, ws.id).catch(errorToast);
      void loadDesigns(ws.host, ws.id).catch(errorToast);
    }
  }, [ws, load]);
  return { ws, systems, shown, designs, design };
}

/** Whether a sync agent's chat is at work now, so its system is syncing. */
function agentWorking(s: ReturnType<typeof useStore.getState>, host: string, id: number | null): boolean {
  const t = id === null ? undefined : s.terminals[host]?.[id];
  return !!t && !t.exit && (t.agent_state === "working" || t.agent_state === "blocked");
}

const openNewSystem = (ws: { host: string; id: string } | null) => ws && useStore.setState({ dialog: { kind: "new-design-system", host: ws.host, workspace: ws.id } });


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
  const { ws, systems, shown, designs, design } = useWorkspaceDesign(true);
  const working = useStore(useShallow((s) => (ws ? (systems ?? []).map((sys) => agentWorking(s, ws.host, sys.agent)) : [])));
  // Each design's agent's live state, for its dot.
  const states = useStore(useShallow((s) => (ws ? (designs ?? []).map((d) => designAgentState(d, d.agent === null ? undefined : s.terminals[ws.host]?.[d.agent]?.agent_state)) : [])));
  const now = useNow(true);
  const empty = designsEmpty(designs, systems);
  const row = "flex h-[34px] w-full items-center gap-3 rounded-md px-3 text-left ui-text-14";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="px-2">
        {/* A design starts from a design system (X65). */}
        <button
          disabled={!systems?.length}
          title={systems?.length ? undefined : "A design starts from a design system"}
          onClick={() => ws && openNewDesign(ws)}
          className={cx(row, "no-drag", systems?.length ? "text-muted hover:bg-panel-2 hover:text-fg" : "text-muted opacity-60")}
        >
          <span className="flex w-4 justify-center">
            <Plus size={15} strokeWidth={1.75} />
          </span>
          <span className="flex-1">New design</span>
          <Kbd>⇧⌘N</Kbd>
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
          {systems?.map((sys, i) => {
            const label = systemLabel(sys, now, !!working[i]);
            const current = !design && sys.slug === shown?.slug;
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
        <nav aria-label="Designs" className="px-2">
          {empty && <p className="px-2 py-1 ui-text-12.5 text-faint">{empty}</p>}
          {designs?.map((d, i) => {
            const label = designRow(d, now, states[i] ?? null);
            const current = d.slug === design?.slug;
            return (
              <button
                key={d.slug}
                aria-current={current ? "page" : undefined}
                onClick={() => ws && showDesign(ws.host, ws.id, d.slug)}
                className={cx("relative flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left ui-text-13 text-fg", current ? "bg-selected" : "hover:bg-panel-2")}
              >
                {current && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                <span className="flex w-[14px] shrink-0 justify-center">{label.state ? <StateGlyph state={label.state} size={14} /> : <span className="h-1.5 w-1.5 rounded-full bg-idle" />}</span>
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span title={d.error ?? d.needs_you?.text} className={cx("flex shrink-0 items-center gap-1 ui-text-11.5 tabular-nums", TONES[label.tone])}>
                  {label.comments && <MessageSquare size={11} />}
                  {label.text}
                </span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/** The main area in Design mode: the open design system, or how to start. */
export function DesignMain() {
  const { ws, systems, shown, design } = useWorkspaceDesign();
  const working = useStore((s) => !!ws && !!shown && agentWorking(s, ws.host, shown.agent));
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const now = useNow(true);
  if (design && ws) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <DesignScreen key={design.slug} host={ws.host} workspace={ws.id} design={design} inset={sidebarOpen ? 0 : 84} />
      </div>
    );
  }
  if (shown && ws) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <DesignSystemView key={shown.slug} host={ws.host} workspace={ws.id} sys={shown} label={systemLabel(shown, now, working)} working={working} inset={sidebarOpen ? 0 : 84} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="drag h-[52px] shrink-0 border-b border-border bg-panel" style={{ paddingLeft: sidebarOpen ? 0 : 84 }} />
      {systems?.length === 0 ? (
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

  // A project moved out of the workspace while the dialog is open is dropped.
  const picks = picksInWorkspace(picked, projects.map((p) => p.id));
  const ready = !!name.trim() && picks.length > 0 && !building;
  const build = async () => {
    if (!ready) return;
    setBuilding(true);
    try {
      const made = await createSystem(host, workspace, { name: name.trim(), projects: picks, cover });
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
      <Field label="Name" hint={<span className="font-mono">{systemFolder(workspace, name, taken) ?? "\u00a0"}</span>}>
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
