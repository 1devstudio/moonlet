// The settings page (X43): a full-window page over the sessions, with the
// nav on the left and one page on the right. The sessions stay mounted
// underneath, so terminals and agents keep running.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bell, Bot, ChevronRight, Folder, GitBranch, Keyboard, Link2, Palette, Search, Server, Settings, Smartphone, SquareTerminal, User, X, ListChecks } from "lucide-react";
import { escapeAction, hostOrder, profilesNeedSignIn, routeFocus, routeKey, settingsCrumbs, settingsNav, type AppPage, type NavEntry, type SettingsRoute } from "../../lib/settingsPage";
import { goSettings } from "../../lib/settingsNavigation";
import { moveSelection, searchSettings, type SearchResult } from "../../lib/settingsSearch";
import { updateStatus } from "../../lib/updater";
import { useStore } from "../../lib/store";
import { useTasks } from "../../lib/tasksStore";
import { IconButton, Kbd, cx } from "../ui";
import { WorkspaceMark } from "../WorkspaceSwitcher";
import { PageBody } from "./controls";
import { ProjectPage } from "./ProjectPage";
import { SearchResults, useSearchContext } from "./SearchResults";
import { ShortcutsPage } from "./ShortcutsPage";
import { WorkspacePage } from "./WorkspacePage";
import { AgentsPage, AppearancePage, GeneralPage, NotificationsPage, TerminalPage } from "./AppPages";
import { TrackersPage } from "./TrackersPage";
import { GitPage } from "./GitPage";
import { HooksPage, ProfilesPage } from "./ClaudePages";
import { HostsPage, PhonesPage, useMobileStatus } from "./MachinePages";
import { devicesOfKind } from "../../lib/mobile";

const ICONS: Record<AppPage, typeof Settings> = {
  general: Settings,
  appearance: Palette,
  terminal: SquareTerminal,
  agents: Bot,
  git: GitBranch,
  notifications: Bell,
  trackers: ListChecks,
  shortcuts: Keyboard,
  profiles: User,
  hooks: Link2,
  hosts: Server,
  phones: Smartphone,
};

export const closeSettings = () => void goSettings(null);


function EntryIcon({ entry }: { entry: NavEntry }) {
  if (entry.mark) return <WorkspaceMark name={entry.label} color={entry.mark} size={14} />;
  if (entry.route.page === "project") return <Folder size={14} className="shrink-0" />;
  if (entry.route.page === "workspace") return null;
  const Icon = ICONS[entry.route.page];
  return <Icon size={14} className="shrink-0" />;
}

interface SearchField {
  query: string;
  setQuery: (q: string) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The id of the selected result. */
  active?: string;
}

function Nav({ route, phones, search }: { route: SettingsRoute; phones: number; search: SearchField }) {
  const hosts = useStore((s) => s.hosts);
  const allWorkspaces = useStore((s) => s.workspaces);
  const allProjects = useStore((s) => s.projects);
  const workspaces = allWorkspaces.local;
  const profiles = useStore((s) => s.profiles.local);
  const defaultAccount = useStore((s) => s.defaultAccounts.local);
  const version = useStore((s) => s.appVersion);
  const attention = useTasks((t) => Object.keys(t.attention).length);
  const status = useStore((s) => updateStatus(s.update, s.updateChecking, s.updateError));
  const groups = useMemo(
    () =>
      settingsNav({
        remoteHosts: Object.values(hosts).filter((h) => h.remote).length,
        phones,
        profilesNeedSignIn: profilesNeedSignIn(workspaces ?? [], profiles ?? [], defaultAccount ?? null),
        trackersNeedAttention: attention,
        workspaces: hostOrder(Object.keys(allWorkspaces)).flatMap((h) =>
          (allWorkspaces[h] ?? []).map((w) => ({ host: h, id: w.id, name: w.name, color: w.color, remote: hosts[h]?.remote ? (hosts[h]?.label ?? h) : null })),
        ),
        projects: hostOrder(Object.keys(allProjects)).flatMap((h) => (allProjects[h] ?? []).map((p) => ({ host: h, id: p.id, name: p.name, remote: hosts[h]?.remote ? (hosts[h]?.label ?? h) : null }))),
      }),
    [hosts, phones, workspaces, profiles, defaultAccount, allWorkspaces, allProjects, attention],
  );
  return (
    <nav aria-label="Settings" className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-panel">
      {/* The traffic lights sit here. */}
      <div data-tauri-drag-region className="drag h-[52px] shrink-0" />
      <div className="flex shrink-0 flex-col gap-2 px-2.5 pb-2.5">
        <button type="button" onClick={closeSettings} className="no-drag flex h-7 items-center gap-2 rounded-md px-2 ui-text-12.5 text-muted hover:bg-hover hover:text-fg">
          <ArrowLeft size={14} />
          <span className="flex-1 text-left">Back to sessions</span>
          <Kbd>Esc</Kbd>
        </button>
        <label className="no-drag flex h-[30px] items-center gap-2 rounded-md border border-border-strong bg-panel-2 px-[9px] text-faint">
          <Search size={13} />
          <input
            ref={search.inputRef}
            type="search"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={search.onKey}
            aria-controls={search.query.trim() ? "settings-search-results" : undefined}
            aria-activedescendant={search.query.trim() && search.active ? search.active : undefined}
            placeholder="Search settings"
            aria-label="Search settings"
            className="min-w-0 flex-1 border-0 bg-transparent ui-text-12.5 text-fg outline-none placeholder:text-faint"
          />
          <Kbd>⌘F</Kbd>
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-2.5 pb-3 pt-1">
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-px">
            <span className="flex h-6 items-center px-2 ui-text-11 font-medium uppercase tracking-[0.1em] text-faint">{g.title}</span>
            {g.entries.map((e) => {
              const active = !search.query.trim() && e.key === routeKey(route);
              return (
                <button
                  key={e.key}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => void goSettings(e.route)}
                  className={cx("flex h-[30px] items-center gap-2.5 rounded-md px-2 text-left ui-text-13", active ? "bg-selected font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}
                >
                  <EntryIcon entry={e} />
                  <span className="flex-1 truncate">{e.label}</span>
                  {e.host && <span className="ui-text-11.5 text-faint">{e.host}</span>}
                  {e.count !== undefined && <span className="ui-text-11.5 text-faint">{e.count}</span>}
                  {e.dot && <span role="img" aria-label={e.dot} className="h-1.5 w-1.5 rounded-full bg-blocked" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-[18px] pb-3 pt-2.5 ui-text-11.5 text-faint">
        <span className="font-mono">moonlet {version ?? "…"}</span>
        {status && (
          <>
            <span>·</span>
            <span className="truncate">{status}</span>
          </>
        )}
      </div>
    </nav>
  );
}

function AppPageBody({ route, mobile }: { route: { page: AppPage }; mobile: ReturnType<typeof useMobileStatus> }) {
  switch (route.page) {
    case "general":
      return <GeneralPage />;
    case "appearance":
      return <AppearancePage />;
    case "terminal":
      return <TerminalPage />;
    case "agents":
      return <AgentsPage />;
    case "git":
      return <GitPage />;
    case "notifications":
      return <NotificationsPage />;
    case "trackers":
      return <TrackersPage />;
    case "shortcuts":
      return <ShortcutsPage />;
    case "profiles":
      return <ProfilesPage />;
    case "hooks":
      return <HooksPage />;
    case "hosts":
      return <HostsPage status={mobile} />;
    case "phones":
      return <PhonesPage status={mobile} />;
  }
}

function Page({ route, mobile }: { route: SettingsRoute; mobile: ReturnType<typeof useMobileStatus> }) {
  if (route.page === "workspace") return <WorkspacePage host={route.host} id={route.id} />;
  if (route.page === "project") return <ProjectPage host={route.host} id={route.id} focus={route.focus} />;
  return (
    <PageBody>
      <AppPageBody route={route} mobile={mobile} />
    </PageBody>
  );
}

/** The workspace's or project's name for the breadcrumb. */
function useRouteName(route: SettingsRoute): string {
  return useStore((s) =>
    route.page === "workspace"
      ? (s.workspaces[route.host]?.find((w) => w.id === route.id)?.name ?? "")
      : route.page === "project"
        ? (s.projects[route.host]?.find((p) => p.id === route.id)?.name ?? "")
        : "",
  );
}

export function SettingsPage({ route }: { route: SettingsRoute }) {
  const root = useRef<HTMLDivElement>(null);
  const mobile = useMobileStatus();
  const name = useRouteName(route);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [flash, setFlash] = useState<{ setting: string; at: number } | null>(null);
  // A route that names a row, such as Manage's Boards (X50), opens on it.
  const focus = routeFocus(route);
  useEffect(() => {
    if (focus) setFlash({ setting: focus, at: Date.now() });
  }, [route]);
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = !!query.trim();
  const searchCtx = useSearchContext(mobile?.devices.length ?? 0, searching);
  const results = useMemo(() => searchSettings(query, searchCtx), [query, searchCtx]);
  const crumbs = searching ? ["Settings", "Search"] : settingsCrumbs(route, name);

  const openResult = (r: SearchResult) => {
    setQuery("");
    setSelected(0);
    if (r.setting) setFlash({ setting: r.setting, at: Date.now() });
    void goSettings(r.route);
  };
  const search: SearchField = {
    query,
    setQuery: (q) => {
      setQuery(q);
      setSelected(0);
    },
    inputRef: searchRef,
    active: results[selected] ? `settings-result-${selected}` : undefined,
    onKey: (e) => {
      if (e.key === "Escape") {
        setQuery("");
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && results[selected]) {
        e.preventDefault();
        openResult(results[selected]);
        return;
      }
      const next = moveSelection(selected, results.length, e.key);
      if (next !== null && results.length) {
        e.preventDefault();
        setSelected(next);
      }
    },
  };

  // ⌘F goes to the search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key.toLowerCase() !== "f" || e.shiftKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]:not([inert] *), [data-recording-shortcut]')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // An opened result's row: scroll to it and highlight it once it renders
  // (a project page's rows come after its config has loaded).
  useEffect(() => {
    if (!flash) return;
    let tries = 0;
    let done: ReturnType<typeof setTimeout> | undefined;
    const find = setInterval(() => {
      const el = root.current?.querySelector<HTMLElement>(`main [data-setting="${flash.setting}"]`);
      if (!el && ++tries < 200) return;
      clearInterval(find);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("settings-flash");
      el.dataset.flash = "true";
      done = setTimeout(() => {
        el.classList.remove("settings-flash");
        delete el.dataset.flash;
      }, 1600);
    }, 50);
    return () => {
      clearInterval(find);
      clearTimeout(done);
    };
  }, [flash]);

  // Esc goes back to the sessions (escapeAction has the exceptions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { dialog, confirm } = useStore.getState();
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editable = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
      const action = escapeAction({
        dialogShown: !!dialog || !!confirm || !!document.querySelector('[role="dialog"]:not([inert] *)'),
        editable,
        recording: !!document.querySelector("[data-recording-shortcut]"),
      });
      if (action === "ignore") return;
      if (action === "leave-field") {
        // After the field's own handler, which still gets this Esc.
        setTimeout(() => target?.blur());
        return;
      }
      e.stopPropagation();
      closeSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Keys go to the page, not to a terminal that had focus behind it.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('nav [aria-current="page"]')?.focus();
  }, []);

  // Each page starts at its top.
  useEffect(() => {
    root.current?.querySelector("[data-settings-scroll]")?.scrollTo(0, 0);
  }, [routeKey(route)]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={root} role="region" aria-label="Settings" data-settings-searching={searching || undefined} className="fixed inset-0 z-40 flex bg-bg text-fg">
      <Nav route={route} phones={mobile ? devicesOfKind(mobile, "phone").length : 0} search={search} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-2 pl-12 pr-4 ui-text-12.5 text-faint">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <ChevronRight size={12} />}
              <span className={i === crumbs.length - 1 ? "text-muted" : undefined}>{c}</span>
            </span>
          ))}
          <span className="flex-1" />
          <IconButton title="Close settings (Esc)" onClick={closeSettings}>
            <X size={14} />
          </IconButton>
        </header>
        {searching && <SearchResults query={query} results={results} selected={selected} onOpen={openResult} />}
        {/* Kept mounted while searching, so a page's unsaved edits survive. */}
        <div className={cx("flex min-h-0 flex-1 flex-col", searching && "hidden")}>
          <Page key={routeKey(route)} route={route} mobile={mobile} />
        </div>
      </main>
    </div>
  );
}
