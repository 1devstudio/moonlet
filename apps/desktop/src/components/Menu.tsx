import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { firstActive, moveActive } from "../lib/menuNav";
import { cx } from "./ui";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      description?: string;
      /** Drawn at the row's right, before its check: the board switcher's column bars. */
      aside?: ReactNode;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; icon?: ReactNode; items: MenuItem[] }
  | { kind: "divider" }
  | { kind: "label"; label: string };

export function MenuItems({ items, onClose, active = null }: { items: MenuItem[]; onClose: () => void; /** The item ↑ and ↓ moved to. */ active?: number | null }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "divider") return <div key={i} className="my-1 border-t border-border" />;
        if (it.kind === "label")
          return (
            <div key={i} className="px-3 pb-1 pt-2 ui-text-11 font-medium uppercase tracking-[0.08em] text-faint">
              {it.label}
            </div>
          );
        if (it.kind === "submenu")
          return (
            <div key={i} className="relative" onMouseEnter={() => setOpen(i)} onMouseLeave={() => setOpen((o) => (o === i ? null : o))}>
              <div className={cx("flex cursor-default items-center gap-2.5 rounded-md px-3 py-[7px] ui-text-14", open === i && "bg-hover")}>
                {it.icon}
                <span className="flex-1">{it.label}</span>
                <ChevronRight size={14} className="text-muted" />
              </div>
              {open === i && (
                <div className="absolute left-full top-[-5px] z-50 ml-1 min-w-[200px] rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
                  <MenuItems items={it.items} onClose={onClose} />
                </div>
              )}
            </div>
          );
        return (
          <button
            key={i}
            data-active={active === i || undefined}
            ref={active === i ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            className={cx("flex w-full items-center gap-2.5 rounded-md px-3 py-[7px] text-left ui-text-14 hover:bg-hover", active === i && "bg-hover", it.danger && "text-error")}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon}
            {it.description ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{it.label}</span>
                <span className="truncate ui-text-12.5 text-muted">{it.description}</span>
              </span>
            ) : (
              <span className="flex-1 truncate">{it.label}</span>
            )}
            {it.hint && <span className="font-mono ui-text-11.5 text-faint">{it.hint}</span>}
            {it.aside}
            {it.checked && <Check size={14} className="text-fg" />}
          </button>
        );
      })}
    </>
  );
}

/**
 * Click-to-open menu anchored to its trigger, with hover submenus. Rendered
 * in a portal so scroll containers (the sidebar) never clip it.
 */
export function Menu({
  trigger,
  items,
  align = "left",
  side = "bottom",
  width = 230,
  search,
}: {
  trigger: (open: () => void) => ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  side?: "bottom" | "top";
  width?: number;
  /** A search box above the items; the caller filters `items` by `query`. */
  search?: { placeholder: string; query: string; onQuery: (q: string) => void };
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = rect !== null;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // ↑ and ↓ move through the items, ↵ picks one (X50 board switcher). A
  // searchable menu starts on its checked item, and on the first match as
  // the query changes.
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const kinds = (list: MenuItem[]) => list.map((it) => it.kind);
  useEffect(() => {
    if (!open) return setActive(null);
    setActive(search ? firstActive(kinds(items), items.map((it) => (it.kind === undefined || it.kind === "item") && !!it.checked)) : null);
  }, [open, search?.query]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The menu's own Escape; a dialog around it must not also close.
        e.stopPropagation();
        return setRect(null);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        return setActive(moveActive(kinds(itemsRef.current), activeRef.current, e.key === "ArrowDown" ? 1 : -1));
      }
      const picked = activeRef.current === null ? undefined : itemsRef.current[activeRef.current];
      if (e.key === "Enter" && picked && (picked.kind === undefined || picked.kind === "item")) {
        e.preventDefault();
        setRect(null);
        return picked.onSelect();
      }
      // A single-character hint doubles as the item's shortcut while the menu is open.
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement | null)?.tagName === "INPUT") return;
      const hit = itemsRef.current.find((it) => (it.kind === undefined || it.kind === "item") && it.hint?.length === 1 && it.hint === e.key);
      if (hit && (hit.kind === undefined || hit.kind === "item")) {
        e.preventDefault();
        setRect(null);
        hit.onSelect();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) setRect(null);
    };
    const onScroll = () => setRect(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);
  const toggle = () => {
    search?.onQuery("");
    setRect((r) => (r ? null : (anchor.current?.getBoundingClientRect() ?? null)));
  };
  const style: React.CSSProperties = { width, position: "fixed" };
  if (rect) {
    style.left = align === "right" ? Math.max(8, rect.right - width) : Math.min(rect.left, window.innerWidth - width - 8);
    if (side === "top") style.bottom = window.innerHeight - rect.top + 4;
    else style.top = rect.bottom + 4;
  }
  return (
    <div ref={anchor} className="no-drag relative">
      {trigger(toggle)}
      {rect &&
        createPortal(
          <div ref={panel} style={style} className="z-[60] rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
            {search && (
              <input
                autoFocus
                aria-label={search.placeholder}
                value={search.query}
                onChange={(e) => search.onQuery(e.target.value)}
                placeholder={search.placeholder}
                className="mb-1 w-full rounded-md bg-panel-2 px-2.5 py-1.5 ui-text-13 outline-none placeholder:text-faint"
              />
            )}
            <div className={cx(search && "max-h-[320px] overflow-y-auto")}>
              <MenuItems items={items} active={active} onClose={() => setRect(null)} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
