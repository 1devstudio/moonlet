// Keep in sync (X60): a file that differs between the central host and this
// Mac, the two versions side by side, with Keep for each.

import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import "../lib/monaco";
import { editorOptions, useEditorLanguage } from "../lib/monaco";
import { rpc } from "../lib/daemon";
import { M, type FileContent } from "../lib/protocol";
import { sesKey, useStore } from "../lib/store";
import { resolveSync, useSync } from "../lib/syncStore";
import { editorFont } from "../lib/uiScale";
import { Button, Dialog, Empty } from "./ui";

/** What one side has: its text, or none when the file is gone there. */
type Side = { text: string | null; binary: boolean };

async function read(host: string, path: string): Promise<Side> {
  try {
    const f = await rpc<FileContent>(host, M.fsRead, { path });
    return { text: f.content, binary: f.binary };
  } catch {
    return { text: null, binary: false };
  }
}

export function SyncCompare({ host, session, path }: { host: string; session: string; path: string }) {
  const copy = useSync((s) => s.copies[sesKey(host, session)]);
  const sessionPath = useStore((s) => s.sessions[host]?.find((w) => w.id === session)?.path);
  const fontSize = useStore((s) => s.settings.term.fontSize);
  const language = useEditorLanguage(path);
  const [sides, setSides] = useState<{ central: Side; here: Side } | null>(null);
  const close = () => useStore.setState({ dialog: null });
  useEffect(() => {
    if (!copy?.path || !sessionPath) return;
    let live = true;
    void Promise.all([read(host, `${sessionPath}/${path}`), read("local", `${copy.path}/${path}`)]).then(([central, here]) => live && setSides({ central, here }));
    return () => {
      live = false;
    };
  }, [host, path, sessionPath, copy?.path]);
  const keep = (side: "central" | "worker") => {
    if (copy) void resolveSync(copy, path, side);
    close();
  };
  const label = (s: Side) => (s.text === null ? " (deleted)" : "");
  return (
    <Dialog
      title={path}
      onClose={close}
      width={1000}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button onClick={() => keep("central")}>Keep {host}'s</Button>
          <Button variant="primary" onClick={() => keep("worker")}>
            Keep this Mac's
          </Button>
        </>
      }
    >
      <div className="mb-2 flex ui-text-12 text-muted">
        <span className="flex-1">
          {host}
          {sides && label(sides.central)}
        </span>
        <span className="flex-1">
          This Mac{sides && label(sides.here)}
        </span>
      </div>
      <div className="h-[60vh] overflow-hidden rounded-lg border border-border">
        {!sides ? null : sides.central.binary || sides.here.binary ? (
          <Empty title="Binary file">No text diff available.</Empty>
        ) : (
          language && (
            <DiffEditor
              theme="moonlet"
              language={language}
              original={sides.central.text ?? ""}
              modified={sides.here.text ?? ""}
              options={{ ...editorOptions, ...editorFont(fontSize), readOnly: true, originalEditable: false, renderSideBySide: true, renderOverviewRuler: false }}
            />
          )
        )}
      </div>
    </Dialog>
  );
}
