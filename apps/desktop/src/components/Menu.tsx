import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { firstActive, menuKey, sameItem } from "../lib/menuNav";
import { cx } from "./ui";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      checked?: boolean;
      danger?: boolean;
      hint?: string;
      description?: ReactNode;
      /** Drawn at the row's right, before its check: the board switcher's column bars. */
      aside?: ReactNode;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; icon?: ReactNode; items: MenuItem[] }
  | { kind: "divider" }
  | { kind: "label"; label: string };

export function MenuItems({
  items,
  onClose,
  active = null,
  offset = 0,
  onActive,
}: {
  items: MenuItem[];
  onClose: () => void;
  /** The item ↑ and ↓ (or the mouse) made active, counted from the menu's first item. */
  active?: number | null;
  /** Where these items start in the menu: a footer's come after the list's. */
  offset?: number;
  onActive?: (i: number) => void;
}) {
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
            data-active={active === i + offset || undefined}
            onMouseMove={onActive && active !== i + offset ? () => onActive(i + offset) : undefined}
            className={cx("flex w-full items-center gap-2.5 rounded-md px-3 py-[7px] text-left ui-text-14", onActive ? active === i + offset && "bg-hover" : "hover:bg-hover", it.danger && "text-error")}
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
  footer = [],
}: {
  trigger: (open: () => void) => ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  side?: "bottom" | "top";
  width?: number;
  /** A search box above the items; the caller filters `items` by `query`. */
  search?: { placeholder: string; query: string; onQuery: (q: string) => void };
  /** Items below the list, outside its scrolling: the board switcher's New board and Manage. */
  footer?: MenuItem[];
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = rect !== null;
  // ↑ and ↓ move through the items, the footer's too, ↵ picks one (X50
  // board switcher); the mouse moves the same highlight. A searchable menu
  // starts on its checked item, and on the first match as the search changes.
  const all = [...items, ...footer];
  const itemsRef = useRef(all);
  itemsRef.current = all;
  const [active, setActive] = useState<number | null>(null);
  const activeLabel = useRef<string | null>(null);
  const label = (i: number | null) => {
    const it = i === null ? undefined : all[i];
    return it && "label" in it ? it.label : null;
  };
  const activate = (i: number | null) => {
    activeLabel.current = label(i);
    setActive(i);
  };
  const query = search?.query;
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open || !search) return activate(null);
    activate(firstActive(all, opening ? "open" : "search"));
  }, [open, query]);
  // Items that change while the menu is open keep the active one where it went.
  const now = open ? sameItem(all, active, activeLabel.current) : null;
  const activeRef = useRef(now);
  activeRef.current = now;
  useEffect(() => {
    if (now !== active) activate(now);
    panel.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [now]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The menu's own Escape; a dialog around it must not also close.
        e.stopPropagation();
        return setRect(null);
      }
      const act = menuKey(e, itemsRef.current, activeRef.current);
      if (act) {
        // The menu's own keys: nothing under it moves or submits.
        e.preventDefault();
        e.stopPropagation();
        if ("move" in act) return activate(act.move);
        const picked = itemsRef.current[act.pick];
        setRect(null);
        if (picked.kind === undefined || picked.kind === "item") picked.onSelect();
        return;
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
          <div ref={panel} data-menu-panel style={style} className="z-[60] rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl">
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
              <MenuItems items={items} active={now} onActive={activate} onClose={() => setRect(null)} />
            </div>
            {footer.length > 0 && (
              <div className="mt-1 border-t border-border pt-1">
                <MenuItems items={footer} offset={items.length} active={now} onActive={activate} onClose={() => setRect(null)} />
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
