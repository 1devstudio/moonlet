// The right rail's Inspector and Palette tabs (X65): the selected element's
// layout, spacing, size, fill and border and effects, each field with its
// token and value and a popover of tokens and a free value; and the design
// system's snippets by group, with search, which a pick or a drag inserts.
// What they decide is in lib/designInspector.ts, lib/designTokens.ts and
// lib/designPalette.ts.

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesignToken } from "../../lib/protocol";
import type { Decl } from "../../lib/designStyle";
import { fieldInput, fieldShows, fieldValue, inspectorSections, pickToken, type Field } from "../../lib/designInspector";
import { popoverTokens } from "../../lib/designTokens";
import { paletteGroups, type Snippet } from "../../lib/designPalette";
import { cx } from "../../lib/cx";
import { Menu } from "../Menu";

/** The orange dot of an off-system element or value. */
export function OffSystemDot({ className }: { className?: string }) {
  return <span aria-label="off-system" title="Off-system: a value matches no token" className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-[#e8a24f]", className)} />;
}

const label = "ui-text-11 font-medium uppercase tracking-[0.08em] text-faint";
const box = "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-panel-2 px-2 text-left font-mono ui-text-12 text-fg hover:border-border-strong";

/** The Inspector of the selected element `tag` `mid`, with its inline
 *  style and the page's computed style of it; `off` the properties whose
 *  values match no token. `onSet` writes a property (null removes it). */
export function InspectorTab({
  tag,
  mid,
  inline,
  computed,
  tokens,
  off,
  locked,
  onSet,
}: {
  tag: string | null;
  mid: string | null;
  inline: Decl[];
  computed: Record<string, string>;
  tokens: DesignToken[];
  off: string[];
  locked: boolean;
  onSet: (prop: string, value: string | null) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [mid]);
  if (!mid || !tag) return <p className="px-4 py-6 text-center ui-text-12.5 text-faint">{locked ? "Edit opens when Claude stops." : "Select an element in Edit mode (V) to inspect it."}</p>;
  const display = fieldValue({ label: "Display", prop: "display", kind: "keyword" }, inline, computed).value || "block";
  return (
    <div aria-label="Inspector" className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex h-11 items-center gap-2 border-b border-border px-3.5">
        <span className="rounded bg-[rgba(91,156,255,0.16)] px-1.5 py-px font-mono ui-text-12 text-[#cfe0ff]">{tag}</span>
        <span className="font-mono ui-text-12 text-faint">{mid}</span>
        {off.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5 ui-text-11.5 text-[#e8a24f]">
            <OffSystemDot /> off-system
          </span>
        )}
      </div>
      {inspectorSections(display).map((s) => (
        <section key={s.title} aria-label={s.title} className="border-b border-border px-3.5 py-3">
          <h3 className={cx(label, "mb-2")}>{s.title}</h3>
          {s.fields.map((f) => (
            <FieldRow
              key={f.prop}
              field={f}
              value={fieldValue(f, inline, computed)}
              tokens={tokens}
              off={off.includes(f.prop) || (f.also ?? []).some((p) => off.includes(p))}
              open={open === f.prop}
              locked={locked}
              onOpen={(o) => setOpen(o ? f.prop : null)}
              onSet={(v) => {
                setOpen(null);
                onSet(f.prop, v);
              }}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  tokens,
  off,
  open,
  locked,
  onOpen,
  onSet,
}: {
  field: Field;
  value: { value: string; inline: boolean };
  tokens: DesignToken[];
  off: boolean;
  open: boolean;
  locked: boolean;
  onOpen: (open: boolean) => void;
  onSet: (value: string | null) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const row = (control: ReactNode) => (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-[72px] shrink-0 ui-text-12.5 text-muted">{field.label}</span>
      {control}
    </div>
  );
  if (field.kind === "keyword") {
    return row(
      <Menu
        width={180}
        trigger={(o) => (
          <button aria-label={field.label} disabled={locked} className={box} onClick={o}>
            <span className="min-w-0 flex-1 truncate">{value.value || "—"}</span>
            <ChevronDown size={11} className="shrink-0 text-faint" />
          </button>
        )}
        items={[...(field.options ?? []).map((o) => ({ label: o, checked: o === value.value, onSelect: () => onSet(o) })), ...(value.inline ? [{ kind: "divider" as const }, { label: "Clear", onSelect: () => onSet(null) }] : [])]}
      />,
    );
  }
  const shown = fieldShows(field, tokens, value.value);
  return row(
    <>
      <button ref={anchor} aria-label={field.label} aria-expanded={open} disabled={locked} className={cx(box, open && "border-accent")} onClick={() => onOpen(!open)}>
        {shown.token ? (
          <>
            <span className="min-w-0 flex-1 truncate">{shown.token}</span>
            <span className="shrink-0 text-faint">{shown.value}</span>
          </>
        ) : (
          <span className={cx("min-w-0 flex-1 truncate", !value.value && "text-faint")}>{value.value || "—"}</span>
        )}
        {off && <OffSystemDot />}
      </button>
      {open && <TokenPopover field={field} value={value.value} tokens={tokens} anchor={anchor} onSet={onSet} onClose={() => onOpen(false)} />}
    </>,
  );
}

/** A field's popover, to the left of the rail: the matching tokens first
 *  with their values, then a free value, any value at all. */
function TokenPopover({
  field,
  value,
  tokens,
  anchor,
  onSet,
  onClose,
}: {
  field: Field;
  value: string;
  tokens: DesignToken[];
  anchor: React.RefObject<HTMLButtonElement | null>;
  onSet: (value: string | null) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<{ right: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPlace({ right: window.innerWidth - r.left + 10, top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 320)) });
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  const list = field.family && field.kind !== "text" && field.kind !== "opacity" ? popoverTokens(tokens, value, field.family) : [];
  const commit = () => {
    const got = fieldInput(field, text);
    if ("error" in got) return setError(got.error);
    onSet(got.set);
  };
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={`${field.label} tokens`}
      className="fixed z-50 flex w-[236px] flex-col rounded-lg border border-border-strong bg-panel py-2 shadow-2xl"
      style={place ? { right: place.right, top: place.top } : { visibility: "hidden" }}
    >
      <h4 className={cx(label, "px-3 pb-1.5")}>
        {field.label} · {list.length ? "tokens" : "value"}
      </h4>
      {list.length > 0 && (
        <div className="max-h-[200px] overflow-y-auto px-1">
          {list.map((t) => (
            <button key={t.name} role="option" aria-selected={false} aria-label={t.name} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left font-mono ui-text-12 text-fg hover:bg-panel-2" onClick={() => onSet(pickToken(field, value, t.name))}>
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="shrink-0 text-faint">{t.value}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 px-3">
        <input
          autoFocus
          aria-label={`${field.label} value`}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          className="h-7 w-full rounded-md border border-border-strong bg-panel-2 px-2 font-mono ui-text-12 text-fg outline-none focus:border-accent"
        />
        <p className={cx("mt-1.5 ui-text-11.5 leading-snug", error ? "text-error" : "text-faint")}>{error ?? "Any value works. One that matches no token marks the element off-system."}</p>
      </div>
    </div>
  );
}

/** The Palette: the design system's snippets by group, with search; a pick
 *  inserts one after the selection, and one dragged onto the page drops
 *  where the page shows. */
export function PaletteTab({
  snippets,
  selected,
  locked,
  onPick,
  onDrag,
}: {
  snippets: Snippet[] | null;
  selected: string | null;
  locked: boolean;
  onPick: (s: Snippet) => void;
  onDrag: (s: Snippet | null) => void;
}) {
  const [query, setQuery] = useState("");
  if (snippets === null) return <p className="px-4 py-6 text-center ui-text-12.5 text-faint">Reading the design system's snippets…</p>;
  const groups = paletteGroups(snippets, query);
  return (
    <div aria-label="Palette" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Search size={13} className="shrink-0 text-faint" />
        <input aria-label="Search snippets" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search snippets" className="min-w-0 flex-1 bg-transparent ui-text-12.5 text-fg outline-none placeholder:text-faint" />
      </div>
      <p className="shrink-0 px-3.5 pt-2.5 ui-text-11.5 text-faint">{locked ? "Edit opens when Claude stops." : selected ? `Click inserts after ${selected}; or drag one onto the page.` : "Click inserts at the end of the page; or drag one onto it."}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {snippets.length === 0 && <p className="px-2 py-6 text-center ui-text-12.5 text-faint">The design system has no snippets yet.</p>}
        {snippets.length > 0 && groups.length === 0 && <p className="px-2 py-6 text-center ui-text-12.5 text-faint">No snippet matches.</p>}
        {groups.map((g) => (
          <section key={g.group} aria-label={g.group} className="pt-2.5">
            <h3 className={cx(label, "px-2 pb-1")}>{g.group}</h3>
            {g.snippets.map((s) => (
              <button
                key={s.id}
                aria-label={s.id}
                title={s.html}
                disabled={locked}
                draggable={!locked}
                onClick={() => onPick(s)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", s.id);
                  e.dataTransfer.effectAllowed = "copy";
                  onDrag(s);
                }}
                onDragEnd={() => onDrag(null)}
                className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-50"
              >
                <span className="flex w-full items-center gap-1.5 ui-text-12.5 text-fg">
                  {s.card} <span className="text-faint">· {s.variant}</span>
                </span>
                <span className="w-full truncate font-mono ui-text-11 text-faint">{s.html.replace(/\s+/g, " ")}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
