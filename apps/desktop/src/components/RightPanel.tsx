import { lazy, Suspense, useEffect } from "react";
import { rpc } from "../lib/daemon";
import { M, type Workspace } from "../lib/protocol";
import { type RightTab, useStore, wsKey } from "../lib/store";
import { ChecksPanel } from "./ChecksPanel";
import { FilesPanel } from "./FilesPanel";
import { PreviewPanel } from "./PreviewPanel";
import { cx } from "./ui";

const ChangesPanel = lazy(() => import("./ChangesPanel"));

const TABS: { id: RightTab; label: string; key: string }[] = [
  { id: "changes", label: "Changes", key: "⇧⌘D" },
  { id: "files", label: "Files", key: "⇧⌘E" },
  { id: "preview", label: "Preview", key: "" },
  { id: "checks", label: "Checks", key: "" },
];

export function RightPanel({ host, ws }: { host: string; ws: Workspace }) {
  const tab = useStore((s) => s.rightTab);
  const count = useStore((s) => s.git[wsKey(host, ws.id)]?.files.length ?? 0);

  // Watch the worktree for live refresh of Changes, Files and Preview.
  useEffect(() => {
    void rpc(host, M.fsWatch, { path: ws.path }).catch(() => {});
    return () => void rpc(host, M.fsUnwatch, { path: ws.path }).catch(() => {});
  }, [host, ws.path]);

  return (
    <div className="flex h-full flex-col border-l border-border bg-panel">
      <div className="drag flex h-[46px] shrink-0 items-end gap-0.5 border-b border-border px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            title={t.key ? `${t.label} (${t.key})` : t.label}
            onClick={() => useStore.setState({ rightTab: t.id })}
            className={cx(
              "no-drag -mb-px flex items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-[12.5px]",
              tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.id === "changes" && count > 0 && <span className="rounded-full bg-raised px-1.5 text-[10.5px] text-muted">{count}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          {tab === "changes" && <ChangesPanel host={host} ws={ws} />}
          {tab === "files" && <FilesPanel host={host} ws={ws} />}
          {tab === "preview" && <PreviewPanel />}
          {tab === "checks" && <ChecksPanel host={host} ws={ws} />}
        </Suspense>
      </div>
    </div>
  );
}
