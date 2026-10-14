import { Inbox, Layers, MessageSquarePlus, Server } from "lucide-react";
import { showTab, type Tab, useApp } from "../lib/app";
import { cx } from "./ui";

const TABS: { id: Tab; label: string; Icon: typeof Inbox }[] = [
  { id: "inbox", label: "Inbox", Icon: Inbox },
  { id: "sessions", label: "Sessions", Icon: Layers },
  { id: "new", label: "New", Icon: MessageSquarePlus },
  { id: "hosts", label: "Hosts", Icon: Server },
];

export function TabBar({ badge }: { badge: number }) {
  const tab = useApp((s) => s.tab);
  return (
    <nav className="grid flex-none grid-cols-4 border-t border-border bg-[rgba(22,22,22,0.96)] px-2 pt-1.5" style={{ paddingBottom: "max(var(--safe-bottom), 8px)" }}>
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={tab === id ? "page" : undefined}
          onClick={() => showTab(id)}
          className={cx("relative flex h-[50px] flex-col items-center justify-center gap-[3px] text-[11px] font-medium", tab === id ? "text-fg" : "text-faint")}
        >
          <Icon size={22} />
          {label}
          {id === "inbox" && badge > 0 && (
            <span className="absolute top-0.5 left-[54%] flex h-4 min-w-4 items-center justify-center rounded-full bg-blocked px-1 text-[10.5px] font-bold text-bg">{badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
