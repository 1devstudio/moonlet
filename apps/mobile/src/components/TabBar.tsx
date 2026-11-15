import { Inbox, Layers, Plus, Server, SquareKanban } from "lucide-react";
import { showTab, TABS, type Tab, useApp } from "../lib/app";
import { useTasksBadge } from "../screens/Tasks";
import { cx } from "./ui";

const LOOK: Record<Tab, { label: string; Icon: typeof Inbox }> = {
  inbox: { label: "Inbox", Icon: Inbox },
  sessions: { label: "Sessions", Icon: Layers },
  new: { label: "New session", Icon: Plus },
  tasks: { label: "Tasks", Icon: SquareKanban },
  hosts: { label: "Hosts", Icon: Server },
};

export function TabBar({ badge }: { badge: number }) {
  const tab = useApp((s) => s.tab);
  // The shown board's cards out of sync.
  const tasks = useTasksBadge();
  return (
    <nav className="grid flex-none grid-cols-5 border-t border-border bg-[rgba(22,22,22,0.96)] px-1 pt-1.5" style={{ paddingBottom: "max(var(--safe-bottom), 8px)" }}>
      {TABS.map((id) => {
        const { label, Icon } = LOOK[id];
        const n = id === "inbox" ? badge : id === "tasks" ? tasks : 0;
        const current = tab === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={id === "new" ? label : undefined}
            aria-current={current ? "page" : undefined}
            onClick={() => showTab(id)}
            className={cx("relative flex h-[50px] flex-col items-center justify-center gap-[3px] text-[11px] font-medium", current ? "text-fg" : "text-faint")}
          >
            {id === "new" ? (
              // The centre action: a round accent button with no label, rising
              // above the bar and ringed in its colour; lighter while New is shown.
              <span className={cx("flex size-[56px] shrink-0 -translate-y-[12px] items-center justify-center rounded-full text-bg shadow-[0_0_0_5px_var(--color-panel),0_12px_32px_rgb(0_0_0/0.5)]", current ? "bg-accent-2" : "bg-accent")}>
                <Plus size={26} strokeWidth={2.4} />
              </span>
            ) : (
              <>
                <Icon size={22} />
                {label}
              </>
            )}
            {n > 0 && (
              <span className={cx("absolute top-0.5 left-[54%] flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10.5px] font-bold text-bg", id === "tasks" ? "bg-accent" : "bg-blocked")}>{n}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
