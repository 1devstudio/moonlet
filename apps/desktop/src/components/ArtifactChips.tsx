// Pieces of Artifacts (X114) the chat uses too: an artifact's kind tile,
// the workspace's artifact rows, the chips of the artifacts a session's next
// message refers to, and the picker that adds one.

import { useEffect, useMemo, useState } from "react";
import { ListChecks, PenTool, Radio, Search, X } from "lucide-react";
import { artifactRows, type ArtifactRow } from "../lib/artifacts";
import { artifactDesigns, artifactKey, chipsOf, loadArtifactDesigns, loadPlans, removeChip, useArtifacts } from "../lib/artifactStore";
import { useDesign } from "../lib/designStore";
import type { Design } from "../lib/protocol";
import { shownWorkspace, useStore } from "../lib/store";
import { connectedHosts } from "../lib/sidebar";
import { cx } from "./ui";

export function KindTile({ kind, size = 22 }: { kind: "plan" | "design"; size?: number }) {
  const Icon = kind === "plan" ? ListChecks : PenTool;
  return (
    <span className={cx("flex shrink-0 items-center justify-center rounded-[5px] bg-panel-2", kind === "plan" ? "text-accent" : "text-merged")} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.6)} />
    </span>
  );
}

/** The rows of the shown workspace, from every connected host. */
export function useArtifactRows(): { rows: ArtifactRow[]; workspace: string | null; hosts: string[] } {
  const shown = useStore((s) => shownWorkspace(s));
  const hostsMap = useStore((s) => s.hosts);
  const projects = useStore((s) => s.projects);
  const joined = connectedHosts(hostsMap);
  const hosts = useMemo(() => joined.split(",").filter(Boolean), [joined]);
  const plans = useArtifacts((s) => s.plans);
  const matches = useArtifacts((s) => s.matches);
  const query = useArtifacts((s) => s.query);
  const kind = useArtifacts((s) => s.kind);
  const design = useDesign();
  const workspace = shown?.id ?? null;
  const rows = useMemo(() => {
    if (!workspace) return [];
    const byHost = (f: (host: string) => Design[] | undefined) => Object.fromEntries(hosts.map((h) => [h, f(h)]));
    const designs = byHost((h) => artifactDesigns(design, h, workspace));
    const projectName = (host: string, id: string) => (projects[host] ?? []).find((p) => p.id === id)?.name;
    const planLists = Object.fromEntries(hosts.map((h) => [h, plans[artifactKey(h, workspace)]]));
    const found = Object.fromEntries(hosts.map((h) => [h, matches[artifactKey(h, workspace)]]));
    return artifactRows({ plans: planLists, designs, workspace, projectName, now: Date.now() }, kind, query, found);
  }, [workspace, hosts, plans, matches, query, kind, design, projects]);
  return { rows, workspace, hosts };
}

/** The artifacts a session's next message refers to, each with × (X114). */
export function ArtifactChipRow({ host, session }: { host: string; session: string }) {
  const chips = useArtifacts((s) => chipsOf(s, host, session));
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pb-1.5 pt-2">
      {chips.map((c) => (
        <span key={c.id} title={`${c.name}: a live reference, read only`} className="inline-flex h-6 max-w-[320px] items-center gap-1.5 rounded-md border border-border-strong bg-panel-2 pl-2 pr-1 ui-text-12 text-fg">
          <KindTile kind={c.kind} size={16} />
          <span className="truncate">{c.name}</span>
          <span className="inline-flex items-center gap-0.5 ui-text-11 text-done">
            <Radio size={11} />
            live
          </span>
          <button title="Remove" className="grid h-[18px] w-[18px] place-items-center rounded text-faint hover:bg-hover hover:text-fg" onClick={() => removeChip(host, session, c.id)}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** A search over the workspace's artifacts, by name, that picks one (X114). */
export function ArtifactPicker({ onPick }: { onPick: (row: ArtifactRow) => void }) {
  const { rows, workspace, hosts } = useArtifactRows();
  // Listed afresh while the picker is open.
  useEffect(() => {
    if (!workspace) return;
    for (const h of hosts) {
      void loadPlans(h, workspace).catch(() => {});
      loadArtifactDesigns(h, workspace);
    }
  }, [workspace, hosts]);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.info.name.toLowerCase().includes(q)) : rows;
  return (
    <div className="flex max-h-[360px] flex-col">
      <label className="flex items-center gap-2 border-b border-border px-2 pb-2 pt-1.5 ui-text-13 text-fg">
        <Search size={13} className="text-faint" />
        <input autoFocus aria-label="Find an artifact" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder="Find a plan or design" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ui-text-11.5 text-faint">this workspace</span>
      </label>
      <div className="flex flex-col gap-px overflow-y-auto pt-1">
        {shown.length === 0 && <div className="px-2 py-1.5 ui-text-12 text-faint">{rows.length ? "No artifact by that name" : "No plans or designs yet"}</div>}
        {shown.map((r) => (
          <button key={r.host + r.info.id} className="flex shrink-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover" onClick={() => onPick(r)}>
            <KindTile kind={r.info.kind} size={18} />
            <span className="max-w-[55%] shrink-0 truncate ui-text-13 text-fg">{r.info.name}</span>
            <span className="min-w-0 truncate ui-text-11.5 text-faint">
              {r.home}
              {r.usedBy ? ` · ${r.usedBy}` : ""}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
