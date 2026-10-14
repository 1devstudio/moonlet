// The settings page (X43): a full-window page over the sessions, with the
// nav on the left and one page on the right. The sessions stay mounted
// underneath, so terminals and agents keep running.

import { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Bell, Bot, ChevronRight, Link2, Palette, Server, Settings, Smartphone, SquareTerminal, User, X } from "lucide-react";
import { escapeAction, profilesNeedSignIn, settingsCrumbs, settingsNav, type AppPage, type SettingsRoute } from "../../lib/settingsPage";
import { updateStatus } from "../../lib/updater";
import { useStore } from "../../lib/store";
import { IconButton, Kbd, cx } from "../ui";
import { AgentsPage, AppearancePage, GeneralPage, NotificationsPage, TerminalPage } from "./AppPages";
import { HooksPage, ProfilesPage } from "./ClaudePages";
import { HostsPage, PhonesPage, useMobileStatus } from "./MachinePages";

const ICONS: Record<AppPage, typeof Settings> = {
  general: Settings,
  appearance: Palette,
  terminal: SquareTerminal,
  agents: Bot,
  notifications: Bell,
  profiles: User,
  hooks: Link2,
  hosts: Server,
  phones: Smartphone,
};

export const closeSettings = () => useStore.setState({ settingsPage: null });
const open = (page: AppPage) => useStore.setState({ settingsPage: { page } });

function Nav({ route, phones }: { route: SettingsRoute; phones: number }) {
  const hosts = useStore((s) => s.hosts);
  const workspaces = useStore((s) => s.workspaces.local);
  const profiles = useStore((s) => s.profiles.local);
  const defaultAccount = useStore((s) => s.defaultAccounts.local);
  const version = useStore((s) => s.appVersion);
  const status = useStore((s) => updateStatus(s.update, s.updateChecking, s.updateError));
  const groups = useMemo(
    () =>
      settingsNav({
        remoteHosts: Object.values(hosts).filter((h) => h.remote).length,
        phones,
        profilesNeedSignIn: profilesNeedSignIn(workspaces ?? [], profiles ?? [], defaultAccount ?? null),
      }),
    [hosts, phones, workspaces, profiles, defaultAccount],
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
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-2.5 pb-3 pt-1">
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-px">
            <span className="flex h-6 items-center px-2 ui-text-11 font-medium uppercase tracking-[0.1em] text-faint">{g.title}</span>
            {g.entries.map((e) => {
              const Icon = ICONS[e.page];
              const active = e.page === route.page;
              return (
                <button
                  key={e.page}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => open(e.page)}
                  className={cx("flex h-[30px] items-center gap-2.5 rounded-md px-2 text-left ui-text-13", active ? "bg-selected font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{e.label}</span>
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

function Page({ route, mobile }: { route: SettingsRoute; mobile: ReturnType<typeof useMobileStatus> }) {
  switch (route.page) {
    case "general":
      return <GeneralPage />;
    case "appearance":
      return <AppearancePage />;
    case "terminal":
      return <TerminalPage />;
    case "agents":
      return <AgentsPage />;
    case "notifications":
      return <NotificationsPage />;
    case "profiles":
      return <ProfilesPage />;
    case "hooks":
      return <HooksPage />;
    case "hosts":
      return <HostsPage />;
    case "phones":
      return <PhonesPage status={mobile} />;
  }
}

export function SettingsPage({ route }: { route: SettingsRoute }) {
  const root = useRef<HTMLDivElement>(null);
  const mobile = useMobileStatus();
  const crumbs = settingsCrumbs(route);

  // Esc goes back to the sessions (escapeAction has the exceptions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const { dialog, confirm } = useStore.getState();
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editable = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
      const action = escapeAction({ dialogShown: !!dialog || !!confirm || !!document.querySelector('[role="dialog"]:not([inert] *)'), editable });
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
  }, [route.page]);

  return (
    <div ref={root} role="region" aria-label="Settings" className="fixed inset-0 z-40 flex bg-bg text-fg">
      <Nav route={route} phones={mobile?.devices.length ?? 0} />
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
        <div data-settings-scroll className="min-h-0 flex-1 overflow-auto px-12 pb-16 pt-3">
          <div className="mx-auto flex max-w-[680px] flex-col gap-8">
            <Page route={route} mobile={mobile} />
          </div>
        </div>
      </main>
    </div>
  );
}
