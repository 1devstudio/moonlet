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
import { compareLabel, compareReadError, READ_CAP_MIB, type CompareSide } from "../lib/sync";
import { editorFont } from "../lib/uiScale";
import { Button, Dialog, Empty } from "./ui";

type Side = CompareSide;

async function read(host: string, path: string): Promise<Side> {
  try {
    const f = await rpc<FileContent>(host, M.fsRead, { path, max_bytes: READ_CAP_MIB * 1024 * 1024 });
    return { text: f.content, binary: f.binary, truncated: f.truncated };
  } catch (e) {
    return { text: null, binary: false, error: compareReadError(e) ?? undefined };
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
          {sides && compareLabel(sides.central)}
        </span>
        <span className="flex-1">
          This Mac{sides && compareLabel(sides.here)}
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

/**
 * A leftover of a routed command (X62): the session's version of `path` on
 * the central host, and the run's, kept in `folder`. The session kept its own.
 */
export function JobLeftoverCompare({ host, session, path, folder }: { host: string; session: string; path: string; folder: string }) {
  const sessionPath = useStore((s) => s.sessions[host]?.find((w) => w.id === session)?.path);
  const fontSize = useStore((s) => s.settings.term.fontSize);
  const language = useEditorLanguage(path);
  const [sides, setSides] = useState<{ kept: Side; run: Side } | null>(null);
  const close = () => useStore.setState({ dialog: null });
  useEffect(() => {
    if (!sessionPath) return;
    let live = true;
    void Promise.all([read(host, `${sessionPath}/${path}`), read(host, `${folder}/${path}`)]).then(([kept, run]) => live && setSides({ kept, run }));
    return () => {
      live = false;
    };
  }, [host, path, folder, sessionPath]);
  return (
    <Dialog
      title={path}
      onClose={close}
      width={1000}
      footer={
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
      }
    >
      <div className="mb-2 flex ui-text-12 text-muted">
        <span className="flex-1">The session's{sides && compareLabel(sides.kept)}</span>
        <span className="flex-1">The run's{sides && compareLabel(sides.run)}</span>
      </div>
      <div className="h-[60vh] overflow-hidden rounded-lg border border-border">
        {!sides ? null : sides.kept.binary || sides.run.binary ? (
          <Empty title="Binary file">No text diff available.</Empty>
        ) : (
          language && (
            <DiffEditor
              theme="moonlet"
              language={language}
              original={sides.kept.text ?? ""}
              modified={sides.run.text ?? ""}
              options={{ ...editorOptions, ...editorFont(fontSize), readOnly: true, originalEditable: false, renderSideBySide: true, renderOverviewRuler: false }}
            />
          )
        )}
      </div>
    </Dialog>
  );
}
