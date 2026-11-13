import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChartNoAxesColumnIncreasing, ChevronRight, GitPullRequest, LayoutGrid, List, ListFilter, Plus, RotateCw, SlidersHorizontal, SquareMinus, SquareTerminal, Tag, UserRound, X } from "lucide-react";
import { cardChoices } from "../../lib/addBoard";
import { type BoardColumn, type BoardConfig, cardFields, type CardField } from "../../lib/boards";
import { columnCounts } from "../../lib/boardScreen";
import { trackerOf } from "../../lib/tasks";
import { setBoardCards, setColumnShow, setDisplay, setFilters, setLayout, resetDisplay, useTasks } from "../../lib/tasksStore";
import { chipOf, type FieldChoice, filterMenuKey, type FilterField, type FilterValue, flipOp, matchingValues, ORDERINGS, type Ordering, removeFilter, searchFilterMenu, type TaskFilter, toggleValue } from "../../lib/taskFilters";
import { Menu } from "../Menu";
import { radioProps, Switch } from "../settings/controls";
import { Button, cx, IconButton, Kbd, selectCls } from "../ui";
import { PriorityBars, TaskGlyph } from "./TasksMode";

export type Panel = "filter" | "display" | null;

const FIELD_ICON: Record<FilterField, ReactNode> = {
  state: <TaskGlyph column="in_progress" size={14} />,
  assignee: <UserRound size={14} />,
  priority: <ChartNoAxesColumnIncreasing size={14} />,
  type: <SquareMinus size={14} />,
  labels: <Tag size={14} />,
  sessions: <SquareTerminal size={14} />,
  pr: <GitPullRequest size={14} />,
  cycle: <RotateCw size={14} />,
};

/** A value's glyph: a State's column category, a Priority's bars. */
function ValueGlyph({ field, value, size = 13 }: { field: FilterField; value: Pick<FilterValue, "id" | "category">; size?: number }) {
  if (field === "state" && value.category) return <TaskGlyph column={value.category} size={size} />;
  if (field === "priority") return <PriorityBars n={Number(value.id)} />;
  return null;
}

/**
 * A panel anchored under `anchor`, in a portal so the header never clips it.
 * A click outside it and its anchor closes it (a `click`, which WebKit's
 * WebDriver raises where it raises no mousedown); so does Esc. Clicks in a Menu opened from it count as inside.
 */
function Popover({ anchor, onClose, align = "right", children }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; align?: "left" | "right"; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState(() => anchor.current?.getBoundingClientRect() ?? null);
  // The latest onClose, so the listeners are added once, not on every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (panel.current?.contains(t) || anchor.current?.contains(t) || t.closest?.("[data-menu-panel]")) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[data-menu-panel]")) return;
      e.stopPropagation();
      close.current();
    };
    const onResize = () => setRect(anchor.current?.getBoundingClientRect() ?? null);
    document.addEventListener("click", onClick, true);
    // Bubbling: a value list's own Esc (back to the fields) stops it first.
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  if (!rect) return null;
  const style: React.CSSProperties = { position: "fixed", top: rect.bottom + 6, ...(align === "right" ? { right: Math.max(8, window.innerWidth - rect.right) } : { left: rect.left }) };
  return createPortal(
    <div ref={panel} style={style} className="no-drag z-[55]">
      {children}
    </div>,
    document.body,
  );
}

const PANEL = "rounded-xl border border-border-strong bg-[#232323] shadow-2xl";
const ROW = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px] text-left ui-text-13";

/** A field's values with "Filter…": each with its glyph, count and a check when picked; a click picks or unpicks it, and the list stays. */
function ValueList({ field, filter, onToggle, onBack, autoFocus }: { field: FieldChoice; filter: TaskFilter | undefined; onToggle: (id: string) => void; onBack?: () => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const values = matchingValues(field, query);
  useEffect(() => setActive(0), [query]);
  return (
    <div role="menu" aria-label={`${field.label} values`} className={cx(PANEL, "w-[230px] p-1")}>
      <input
        autoFocus={autoFocus}
        aria-label={`Filter ${field.label.toLowerCase()} values`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter…"
        onKeyDown={(e) => {
          const act = filterMenuKey(e.key, { list: "values", active, count: values.length, row: "value", query });
          // Without onBack (under a chip), Esc is the popover's: it closes.
          if (!act || ("back" in act && !onBack)) return;
          e.preventDefault();
          e.stopPropagation();
          if ("move" in act) setActive(act.move);
          else if ("pick" in act) onToggle(values[act.pick].id);
          else if ("back" in act) onBack?.();
        }}
        className="mb-1 w-full rounded-md bg-panel-2 px-2.5 py-1.5 ui-text-13 outline-none placeholder:text-faint"
      />
      <div className="max-h-[320px] overflow-y-auto">
        {values.map((v, i) => {
          const on = !!filter?.values.includes(v.id);
          return (
            <button
              key={v.id}
              role="menuitemcheckbox"
              aria-checked={on}
              onMouseMove={() => setActive(i)}
              onClick={() => onToggle(v.id)}
              className={cx(ROW, i === active && "bg-hover")}
            >
              <ValueGlyph field={field.field} value={v} />
              <span className="min-w-0 flex-1 truncate">{v.label}</span>
              <span className="font-mono ui-text-12 tabular-nums text-faint">{v.count}</span>
              <span className="w-[14px]">{on && <Check size={14} className="text-fg" />}</span>
            </button>
          );
        })}
        {!values.length && <div className="px-2.5 py-1.5 ui-text-12.5 text-faint">No value matches</div>}
      </div>
    </div>
  );
}

/** The Filter menu (X100): "Add filter…", the fields, each opening its values beside the menu. */
function FilterMenu({ fields, filters, onChange }: { fields: FieldChoice[]; filters: TaskFilter[]; onChange: (f: TaskFilter[]) => void }) {
  const [query, setQuery] = useState("");
  const [openField, setOpenField] = useState<FilterField | null>(null);
  const [active, setActive] = useState(0);
  // A field's values opened by → or ↵ take the focus; opened by pointing, the focus stays in Add filter….
  const [byKey, setByKey] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const found = searchFilterMenu(fields, query);
  const rows = [...found.fields.map((f) => ({ kind: "field" as const, f })), ...found.values.map((v) => ({ kind: "value" as const, v }))];
  useEffect(() => setActive(0), [query]);
  const toggle = (field: FilterField, id: string) => onChange(toggleValue(filters, field, id));
  const back = () => {
    setOpenField(null);
    input.current?.focus();
  };
  const point = (field: FilterField) => {
    if (field === openField) return;
    // The values panel about to close has the focus: give it back to Add filter….
    if (menu.current?.querySelector('[role="menu"]')?.contains(document.activeElement)) input.current?.focus();
    setByKey(false);
    setOpenField(field);
  };
  return (
    <div ref={menu} role="menu" aria-label="Add filter" className={cx(PANEL, "relative w-[240px] p-1")}>
      <div className="mb-1 flex items-center gap-2 rounded-md bg-panel-2 pr-1.5">
        <input
          ref={input}
          autoFocus
          aria-label="Add filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add filter…"
          onKeyDown={(e) => {
            const act = filterMenuKey(e.key, { list: "fields", active, count: rows.length, row: rows[active]?.kind ?? "field", query });
            if (!act || "back" in act) return;
            e.preventDefault();
            if ("move" in act) return setActive(act.move);
            const row = rows["open" in act ? act.open : act.pick];
            if (row.kind === "field") {
              setByKey(true);
              setOpenField(row.f.field);
            } else toggle(row.v.field, row.v.value.id);
          }}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 ui-text-13 outline-none placeholder:text-faint"
        />
        <Kbd>F</Kbd>
      </div>
      {rows.map((r, i) => {
        if (r.kind === "value") {
          const on = !!filters.find((f) => f.field === r.v.field)?.values.includes(r.v.value.id);
          return (
            <button key={`${r.v.field} ${r.v.value.id}`} role="menuitemcheckbox" aria-checked={on} onMouseMove={() => setActive(i)} onClick={() => toggle(r.v.field, r.v.value.id)} className={cx(ROW, i === active && "bg-hover")}>
              <ValueGlyph field={r.v.field} value={r.v.value} />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted">{r.v.fieldLabel} › </span>
                {r.v.value.label}
              </span>
              {on && <Check size={14} className="text-fg" />}
            </button>
          );
        }
        const f = r.f;
        const open = openField === f.field;
        return (
          <div key={f.field}>
            {/* Sessions, Pull request and Cycle are about the work, after the tracker's own fields. */}
            {f.field === "sessions" && !query && <div className="my-1 border-t border-border" />}
            <div className="relative" onMouseEnter={() => point(f.field)}>
              <button aria-haspopup="menu" aria-expanded={open} onMouseMove={() => setActive(i)} onClick={() => point(f.field)} className={cx(ROW, (open || i === active) && "bg-hover")}>
                <span className="flex w-[14px] justify-center text-muted">{FIELD_ICON[f.field]}</span>
                <span className="flex-1">{f.label}</span>
                <ChevronRight size={14} className="text-muted" />
              </button>
              {open && (
                <div className="absolute right-full top-[-5px] z-10 mr-1">
                  <ValueList field={f} filter={filters.find((x) => x.field === f.field)} onToggle={(id) => toggle(f.field, id)} onBack={back} autoFocus={byKey} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!rows.length && <div className="px-2.5 py-1.5 ui-text-12.5 text-faint">No filter matches</div>}
    </div>
  );
}

/** Board | List, with their icons (X45, in Display options since X100). */
function LayoutChoice() {
  const layout = useTasks((t) => t.layout);
  const options = [
    { id: "list" as const, label: "List", icon: <List size={13} /> },
    { id: "board" as const, label: "Board", icon: <LayoutGrid size={13} /> },
  ];
  const checked = options.findIndex((o) => o.id === layout);
  return (
    <div role="radiogroup" aria-label="Layout" className="flex gap-0.5 rounded-[7px] border border-border bg-panel-2 p-0.5">
      {options.map((o, i) => (
        <button key={o.id} type="button" {...radioProps(i, checked, options.length, (k) => setLayout(options[k].id))} className={cx("flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[5px] ui-text-12.5", o.id === layout ? "bg-raised text-fg shadow-[0_0_0_1px_var(--color-border-strong)]" : "text-muted hover:text-fg")}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Display options (X100): layout, ordering, columns, the board's options and the card's properties. */
function DisplayOptions({ board, columns, estimate }: { board: BoardConfig; columns: BoardColumn[]; estimate: string | null }) {
  const display = useTasks((t) => t.display);
  const hideEmptyDone = useTasks((t) => t.filters.hideEmptyDone);
  const ids = { ordering: useId(), empty: useId(), done: useId(), sessions: useId() };
  const counts = columnCounts(columns);
  const show = (c: { show?: "fold" | "hide" }) => c.show ?? "show";
  const fields = cardFields(board);
  const choices = cardChoices(trackerOf(board.connection) ?? "github", estimate, fields);
  const flip = (f: CardField) => setBoardCards(board.id, choices.map(([c]) => c).filter((c) => (c === f ? !fields.includes(c) : fields.includes(c))));
  const row = "flex min-h-[28px] items-center gap-3 text-muted";
  const section = "mt-3 flex flex-col gap-2.5 border-t border-border pt-3";
  return (
    <div role="dialog" aria-label="Display options" className={cx(PANEL, "w-[320px] p-3 ui-text-13")}>
      <LayoutChoice />
      <div className="mt-3 flex flex-col gap-2.5">
        <div className={row}>
          <span id={ids.ordering} className="flex-1">
            Ordering
          </span>
          <select aria-labelledby={ids.ordering} value={display.ordering} onChange={(e) => setDisplay({ ...display, ordering: e.target.value as Ordering })} className={cx(selectCls, "w-[150px]")}>
            {ORDERINGS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="flex-1">Columns</span>
          <Menu
            align="right"
            width={220}
            items={columns.map((c) => ({
              kind: "submenu" as const,
              label: c.name,
              items: (["show", "fold", "hide"] as const).map((v) => ({ label: v === "show" ? "Show" : v === "fold" ? "Fold" : "Hide", checked: show(c) === v, onSelect: () => setColumnShow(board.id, c.name, v) })),
            }))}
            trigger={(open) => (
              <button onClick={open} className="flex h-[28px] items-center gap-1.5 rounded-md border border-border-strong bg-panel-2 px-2 ui-text-12.5 text-fg">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4v16M10 4v16M16 4v16M22 4v16" />
                </svg>
                {counts.shown} shown{counts.folded > 0 && ` · ${counts.folded} folded`}
              </button>
            )}
          />
        </div>
      </div>
      <div className={section}>
        <div className="ui-text-12.5 font-medium text-fg">Board options</div>
        <div className={row}>
          <span id={ids.empty} className="flex-1">
            Show empty columns
          </span>
          <Switch on={display.showEmpty} onChange={(on) => setDisplay({ ...display, showEmpty: on })} labelledBy={ids.empty} />
        </div>
        <div className={row}>
          <span id={ids.done} className="flex-1">
            Hide empty Done
          </span>
          <Switch on={hideEmptyDone} onChange={(on) => setFilters({ hideEmptyDone: on })} labelledBy={ids.done} />
        </div>
        <div className={row}>
          <span id={ids.sessions} className="flex-1">
            Show sessions on cards
          </span>
          <Switch on={display.sessions} onChange={(on) => setDisplay({ ...display, sessions: on })} labelledBy={ids.sessions} />
        </div>
      </div>
      <div className={section}>
        <div className="ui-text-12.5 font-medium text-fg">Card properties</div>
        <div role="group" aria-label="Card properties" className="flex flex-wrap gap-1.5">
          {choices.map(([f, label]) => {
            const on = fields.includes(f);
            return (
              <button key={f} aria-pressed={on} onClick={() => flip(f)} className={cx("h-6 rounded-full border border-border-strong px-2.5 ui-text-12", on ? "bg-raised text-fg" : "text-faint hover:text-muted")}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex justify-end border-t border-border pt-2.5">
        <Button size="sm" variant="ghost" onClick={() => resetDisplay(board.id)}>
          Reset to default
        </Button>
      </div>
    </div>
  );
}

const TOOL = "no-drag relative inline-flex h-[28px] min-w-[28px] items-center justify-center gap-1.5 rounded-md border border-border-strong px-1.5 ui-text-12 text-muted hover:bg-raised hover:text-fg aria-expanded:bg-raised aria-expanded:text-fg";

/** The header's Filter and Display options icons (X100), each opening its panel; `open` is shared with F, V and the filter row's +. */
export function HeaderTools({ board, columns, estimate, fields, filters, onChange, open, onOpen }: {
  board: BoardConfig;
  columns: BoardColumn[];
  estimate: string | null;
  fields: FieldChoice[];
  filters: TaskFilter[];
  onChange: (f: TaskFilter[]) => void;
  open: Panel;
  onOpen: (p: Panel) => void;
}) {
  const filterBtn = useRef<HTMLButtonElement>(null);
  const displayBtn = useRef<HTMLButtonElement>(null);
  const n = filters.length;
  const close = () => onOpen(null);
  return (
    <>
      <button ref={filterBtn} title="Filter  F" aria-label={n ? `Filter, ${n} applied` : "Filter"} aria-haspopup="menu" aria-expanded={open === "filter"} onClick={() => onOpen(open === "filter" ? null : "filter")} className={cx(TOOL, n > 0 && "text-fg")}>
        <ListFilter size={14} />
        {n > 0 && <span className="h-4 min-w-4 rounded-full bg-accent px-1 text-center font-mono ui-text-11 font-semibold leading-4 text-bg">{n}</span>}
      </button>
      <button ref={displayBtn} title="Display options  V" aria-label="Display options" aria-haspopup="dialog" aria-expanded={open === "display"} onClick={() => onOpen(open === "display" ? null : "display")} className={TOOL}>
        <SlidersHorizontal size={14} />
      </button>
      {open === "filter" && (
        <Popover anchor={filterBtn} onClose={close}>
          <FilterMenu fields={fields} filters={filters} onChange={onChange} />
        </Popover>
      )}
      {open === "display" && (
        <Popover anchor={displayBtn} onClose={close}>
          <DisplayOptions board={board} columns={columns} estimate={estimate} />
        </Popover>
      )}
    </>
  );
}

/** One applied filter (X100): its field and value open its values under it, its op flips is / is not, × removes it. */
function Chip({ filter, field, filters, onChange }: { filter: TaskFilter; field: FieldChoice | undefined; filters: TaskFilter[]; onChange: (f: TaskFilter[]) => void }) {
  const [picking, setPicking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chip = chipOf(filter);
  const part = "inline-flex items-center gap-1.5 border-l border-border-strong px-2 first:border-l-0 hover:bg-hover";
  const one = filter.values.length === 1 ? filter.values[0] : null;
  const glyph = one !== null ? (field?.values.find((v) => v.id === one) ?? { id: one }) : null;
  return (
    <div ref={box} role="group" aria-label={`${chip.field} ${chip.op} ${chip.value}`} className="no-drag inline-flex h-[26px] items-stretch overflow-hidden rounded-md border border-border-strong bg-panel-2 ui-text-12.5">
      <button onClick={() => setPicking(true)} className={cx(part, "text-muted")}>
        <span className="flex text-muted">{FIELD_ICON[filter.field]}</span>
        {chip.field}
      </button>
      <button title={filter.not ? "Keep these instead" : "Leave these out instead"} onClick={() => onChange(flipOp(filters, filter.field))} className={cx(part, "text-faint")}>
        {chip.op}
      </button>
      <button onClick={() => setPicking(true)} className={cx(part, "text-fg")}>
        {glyph && <ValueGlyph field={filter.field} value={glyph} size={12} />}
        {chip.value}
      </button>
      <button title="Remove filter" aria-label={`Remove ${chip.field} filter`} onClick={() => onChange(removeFilter(filters, filter.field))} className={cx(part, "px-1.5 text-faint")}>
        <X size={12} />
      </button>
      {picking && field && (
        <Popover anchor={box} align="left" onClose={() => setPicking(false)}>
          <ValueList autoFocus field={field} filter={filter} onToggle={(id) => onChange(toggleValue(filters, filter.field, id))} />
        </Popover>
      )}
    </div>
  );
}

/** The applied filters' row under the header (X100): a chip each, +, "8 of 14 tasks" and Clear; not drawn without a filter. */
export function FilterBar({ fields, filters, onChange, count, onAdd }: { fields: FieldChoice[]; filters: TaskFilter[]; onChange: (f: TaskFilter[]) => void; count: string; onAdd: () => void }) {
  if (!filters.length) return null;
  return (
    <div role="group" aria-label="Applied filters" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
      {filters.map((f) => (
        <Chip key={f.field} filter={f} field={fields.find((x) => x.field === f.field)} filters={filters} onChange={onChange} />
      ))}
      <IconButton title="Add filter" onClick={onAdd}>
        <Plus size={14} />
      </IconButton>
      <span className="ml-auto ui-text-12 tabular-nums text-faint">{count}</span>
      <Button size="sm" variant="ghost" onClick={() => onChange([])}>
        Clear
      </Button>
    </div>
  );
}
