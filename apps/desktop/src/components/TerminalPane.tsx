import { useEffect, useRef } from "react";
import { RotateCw, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M } from "../lib/protocol";
import { errorToast, getLayout, setLayout, useStore } from "../lib/store";
import { getEntry } from "../lib/terminals";
import { Button } from "./ui";

function resolvePath(base: string, p: string, home: string | null): string {
  if (p.startsWith("/")) return p;
  if (p.startsWith("~/") && home) return home + p.slice(1);
  const parts = (base + "/" + p).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function TerminalPane({ host, session, wsId, focused, visible }: { host: string; session: number; wsId: string; focused: boolean; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.sessions[host]?.[session]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    const entry = getEntry(host, session);
    entry.mount(el);
    entry.onFileLink = (p, line) => {
      const cur = useStore.getState().sessions[host]?.[session];
      const base = entry.cwd || cur?.reported_cwd || cur?.cwd || "/";
      const path = resolvePath(base, p, home);
      const target = { host, path, line };
      if (path.endsWith(".md") || path.endsWith(".markdown")) useStore.setState({ preview: target, rightTab: "files", rightOpen: true });
      else useStore.setState({ openFile: target, rightTab: "files", rightOpen: true });
    };
    return () => entry.unmount();
  }, [host, session, visible, home]);

  useEffect(() => {
    if (focused && visible) getEntry(host, session).focus();
  }, [focused, visible, host, session]);

  const exited = info?.exit;
  return (
    <div
      className="relative h-full w-full overflow-hidden bg-bg"
      onMouseDown={() => {
        const l = getLayout(host, wsId);
        if (l.focused !== session) setLayout(host, wsId, { ...l, focused: session });
      }}
    >
      <div ref={ref} className="absolute inset-0" />
      {exited && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-border bg-panel/95 px-3 py-1.5 text-[12px] text-muted">
          <span>
            Process exited
            {exited.code !== null ? ` with code ${exited.code}` : exited.signal !== null ? ` (signal ${exited.signal})` : ""}.
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await rpc(host, M.sessionCreate, {
                    cwd: info.cwd,
                    command: info.command,
                    kind: info.kind,
                    title: info.title,
                    agent: info.agent,
                    workspace_id: info.workspace_id,
                  });
                  await rpc(host, M.sessionKill, { id: session, remove: true });
                } catch (e) {
                  errorToast(e);
                }
              }}
            >
              <RotateCw size={12} /> Restart
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void rpc(host, M.sessionKill, { id: session, remove: true })}>
              <X size={12} /> Close
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
