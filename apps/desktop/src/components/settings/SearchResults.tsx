// The settings search's results (X43): matching settings with their page and
// value. ↑↓ and ↵ work from the search field; a click opens one too.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { profileName } from "../../lib/profiles";
import { M, type ProjectConfig } from "../../lib/protocol";
import type { SearchContext, SearchResult } from "../../lib/settingsSearch";
import { useStore } from "../../lib/store";
import { cx } from "../ui";
import { PageBody, PageHeading } from "./controls";
import { trackersConfig, useTasks } from "../../lib/tasksStore";

/** What the search needs from the store. Projects' configs are read when a
 * search starts, for their scripts' values. */
export function useSearchContext(phones: number, searching: boolean): SearchContext {
  const settings = useStore((s) => s.settings);
  const appVersion = useStore((s) => s.appVersion);
  const claudeInstalled = useStore((s) => s.claudeVersions.installed);
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const profiles = useStore((s) => s.profiles);
  const trackers = useTasks((t) => trackersConfig(t));
  const [configs, setConfigs] = useState<Record<string, ProjectConfig | null>>({});
  useEffect(() => {
    if (!searching) return;
    // Read again for each search: a script saved since then shows its new value.
    for (const [host, list] of Object.entries(projects))
      for (const p of list) {
        const key = `${host}/${p.id}`;
        void rpc<ProjectConfig>(host, M.projectConfig, { id: p.id })
          .then((cfg) => setConfigs((c) => ({ ...c, [key]: cfg })))
          .catch(() => {});
      }
  }, [searching, projects]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(
    () => ({
      settings,
      appVersion,
      claudeInstalled,
      profiles: (profiles.local?.length ?? 0) + 1,
      remoteHosts: Object.values(hosts).filter((h) => h.remote).length,
      phones,
      workspaces: Object.entries(workspaces).flatMap(([host, list]) => list.map((w) => ({ host, id: w.id, name: w.name, color: w.color, profile: profileName(w, profiles[host] ?? []) }))),
      projects: Object.entries(projects).flatMap(([host, list]) => list.map((p) => ({ host, id: p.id, name: p.name, base_branch: p.base_branch, config: configs[`${host}/${p.id}`] }))),
      trackers,
    }),
    [settings, appVersion, claudeInstalled, hosts, workspaces, projects, profiles, phones, configs, trackers],
  );
}

export function SearchResults({ query, results, selected, onOpen }: { query: string; results: SearchResult[]; selected: number; onOpen: (r: SearchResult) => void }) {
  return (
    <PageBody>
      <PageHeading title={results.length ? `${results.length === 1 ? "1 setting matches" : `${results.length} settings match`} “${query.trim()}”` : `No settings match “${query.trim()}”`}>
        {results.length ? "↑↓ to move, ↵ to open the setting. Esc clears the search." : "Try another word, or Esc to clear the search."}
      </PageHeading>
      {results.length > 0 && (
        <>
          <div id="settings-search-results" role="listbox" aria-label="Matching settings" className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-panel [&>*+*]:border-t [&>*+*]:border-border">
            {results.map((r, i) => (
              <button
                key={r.key}
                id={`settings-result-${i}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                tabIndex={-1}
                onClick={() => onOpen(r)}
                ref={(el) => {
                  if (el && i === selected) el.scrollIntoView({ block: "nearest" });
                }}
                className={cx("flex items-center gap-3 py-[11px] pl-4 pr-3.5 text-left text-faint", i === selected ? "bg-selected" : "hover:bg-panel-2")}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate ui-text-13 text-fg">
                    {r.before}
                    {r.hit && <mark className="bg-transparent font-semibold text-accent-2">{r.hit}</mark>}
                    {r.after}
                  </span>
                  <span className="truncate ui-text-12 text-muted">{r.path}</span>
                </span>
                {r.value && <span className="max-w-[200px] truncate ui-text-12.5 text-muted">{r.value}</span>}
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
          <p className="m-0 px-0.5 ui-text-12 text-muted">Opening a result shows its page and briefly highlights the row.</p>
        </>
      )}
    </PageBody>
  );
}
