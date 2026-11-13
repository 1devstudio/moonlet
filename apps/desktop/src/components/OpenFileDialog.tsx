// Open file… (⌘P, X96): a session's file by name, at `:line` or `:start-end`.

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { openFileTab } from "../lib/actions";
import { setMode } from "../lib/mode";
import { findFiles, openFileMessage, parseFileQuery, rangeLabel } from "../lib/openFileQuery";
import { projectFiles } from "../lib/projectFiles";
import { useStore } from "../lib/store";
import { Kbd } from "./ui";

export function OpenFileDialog({ host, session, root }: { host: string; session: string; root: string }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let live = true;
    void projectFiles(host, root).then((f) => live && setFiles(f));
    return () => {
      live = false;
    };
  }, [host, root]);

  const query = parseFileQuery(q);
  const rows = useMemo(() => findFiles(files ?? [], query.name), [files, query.name]);
  const lines = rangeLabel(query);
  useEffect(() => {
    list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const close = () => useStore.setState({ dialog: null });
  const open = (rel: string | undefined) => {
    if (!rel) return;
    close();
    setMode("sessions");
    openFileTab(host, session, `${root.replace(/\/+$/, "")}/${rel}`, query.line, query.endLine);
  };

  const empty = openFileMessage(query.name, files, rows.length);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Open file"
        className="overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        style={{ width: "min(560px, 90vw)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <FileText size={15} className="shrink-0 text-faint" />
          <input
            ref={input}
            value={q}
            aria-label="File name"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((v) => Math.max(0, Math.min(v + 1, rows.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((v) => Math.max(v - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                open(rows[sel]);
              } else if (e.key === "Escape") {
                close();
              }
            }}
            placeholder="File name, then :line or :start-end"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="min-w-0 flex-1 bg-transparent py-3 ui-text-14 text-fg outline-none placeholder:text-faint"
          />
          {lines && <span className="shrink-0 font-mono ui-text-11 text-faint">{lines}</span>}
        </div>

        <div ref={list} className="overflow-y-auto py-1" style={{ maxHeight: "min(50vh, 420px)" }}>
          {rows.map((f, i) => {
            const cut = f.lastIndexOf("/");
            return (
              <div
                key={f}
                data-row={i}
                data-file-row={f}
                className="flex cursor-default items-center gap-2 px-4 ui-text-13"
                style={{ minHeight: 32, background: i === sel ? "var(--color-raised)" : undefined }}
                onMouseEnter={() => setSel(i)}
                onClick={() => open(f)}
              >
                <span className="shrink-0 text-fg">{f.slice(cut + 1)}</span>
                {cut > 0 && <span className="min-w-0 truncate ui-text-11.5 text-faint">{f.slice(0, cut)}</span>}
              </div>
            );
          })}
          {empty && <div className="px-4 py-3 ui-text-12.5 text-faint">{empty}</div>}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 ui-text-11.5 text-faint">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
