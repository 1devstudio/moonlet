import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronRight, FileText, Plus, Terminal } from "lucide-react";
import type { NamedItem } from "../lib/protocol";
import { type PlusEntry, plusEntries } from "../lib/plusMenu";
import { cx } from "./ui";

const panel = "rounded-xl border border-border-strong bg-[#1a1a1a] p-1.5 shadow-[0_12px_32px_rgba(0,0,0,.5)]";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-[3px] ui-text-12 text-muted">
      {keys.map((k) => (
        <span key={k} className="grid h-5 min-w-5 place-items-center rounded border border-border-strong bg-panel px-1">
          {k}
        </span>
      ))}
    </span>
  );
}

/** `controls` names the submenu the row opens, for assistive tech. */
function Row({ icon, label, active, trailing, controls, onEnter, onClick }: { icon: ReactNode; label: string; active?: boolean; trailing?: ReactNode; controls?: string; onEnter?: () => void; onClick?: () => void }) {
  return (
    <button
      aria-expanded={controls ? !!active : undefined}
      aria-controls={controls && active ? controls : undefined}
      className={cx("flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left ui-text-13.5 text-fg hover:bg-hover", active && "bg-hover")}
      onMouseEnter={onEnter}
      onClick={onClick}
    >
      <span className="flex shrink-0 text-fg">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

const chevron = <ChevronRight size={14} className="text-muted" />;

/**
 * The `+` beside the chat input (X29): attach files, and in a session the
 * agent's slash commands and subagents. Submenus open on hover, beside the
 * menu, the way the design lays them out.
 */
export function PlusMenu({
  variant,
  onAttach,
  commands = [],
  onCommand,
  agents = [],
  onAgent,
}: {
  variant: "chat" | "composer";
  onAttach: () => void;
  commands?: string[];
  onCommand?: (name: string) => void;
  agents?: NamedItem[];
  onAgent?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<PlusEntry | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const ids = useId();
  // The menu renders on top of everything (a narrow pane would clip it),
  // above the +, moved left as needed to stay in the window.
  const [pos, setPos] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const w = pop.current?.offsetWidth ?? 0;
    const want = variant === "chat" ? r.left : r.right - w;
    const left = Math.max(8, Math.min(want, window.innerWidth - w - 8));
    const bottom = window.innerHeight - r.top + 8;
    if (pos.left !== left || pos.bottom !== bottom) setPos({ left, bottom });
  });

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The menu's own Escape: it must not also stop the agent.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setSub(null);
  }, [open]);

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const row = (entry: PlusEntry) => {
    switch (entry) {
      case "attach":
        return <Row key={entry} icon={<FileText size={15} />} label="Attach files or images" trailing={<Keys keys={["⌘", "U"]} />} onEnter={() => setSub(null)} onClick={choose(onAttach)} />;
      case "commands":
        return <Row key={entry} icon={<Terminal size={15} />} label="Slash commands" active={sub === entry} controls={`${ids}-${entry}`} trailing={chevron} onEnter={() => setSub(entry)} onClick={() => setSub(entry)} />;
      case "agents":
        return <Row key={entry} icon={<Bot size={15} />} label="Subagents" active={sub === entry} controls={`${ids}-${entry}`} trailing={chevron} onEnter={() => setSub(entry)} onClick={() => setSub(entry)} />;
    }
  };

  const sections = plusEntries({ variant, agents: agents.length });

  return (
    <div ref={root} className="relative">
      <button
        title="Add files, commands and more"
        className={cx("relative grid h-8 w-8 place-items-center rounded-lg text-fg hover:bg-hover", open && "bg-hover")}
        onClick={() => setOpen(!open)}
      >
        <Plus size={17} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} style={{ position: "fixed", ...pos }} className={cx("z-[60] flex items-end gap-1", variant !== "chat" && "flex-row-reverse")}>
            <div className={cx(panel, "flex w-[260px] flex-col gap-px")}>
              {sections.map((s, i) => (
                <div key={i} className="flex flex-col gap-px">
                  {i > 0 && <div className="mx-2 my-[5px] h-px bg-border-strong" />}
                  {s.map(row)}
                </div>
              ))}
            </div>
            {sub === "commands" && (
              <div id={`${ids}-commands`} className={cx(panel, "flex max-h-[320px] w-[240px] flex-col gap-px overflow-y-auto")}>
                {commands.length === 0 && <div className="px-2 py-1.5 ui-text-12 text-faint">No commands</div>}
                {commands.map((c) => (
                  <button key={c} className="flex h-8 shrink-0 items-center rounded-lg px-2 text-left font-mono ui-text-12.5 text-fg hover:bg-hover" onClick={choose(() => onCommand?.(c))}>
                    <span className="truncate">/{c}</span>
                  </button>
                ))}
              </div>
            )}
            {sub === "agents" && (
              <div id={`${ids}-agents`} className={cx(panel, "flex max-h-[320px] w-[300px] flex-col gap-px overflow-y-auto")}>
                {agents.map((a) => (
                  <button key={a.name} className="flex shrink-0 flex-col rounded-lg px-2 py-1.5 text-left hover:bg-hover" onClick={choose(() => onAgent?.(a.name))}>
                    <span className="truncate font-mono ui-text-12.5 text-fg">{a.name}</span>
                    {a.description && <span className="line-clamp-2 ui-text-11.5 text-muted">{a.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
