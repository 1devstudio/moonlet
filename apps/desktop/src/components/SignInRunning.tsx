// A sign-in that Sign in on every member started (X75): its terminal in a
// window, for any question it asks. This Mac's own terminal, or another
// member's followed through the central host. Closes when it succeeds; a
// failure stays, so its output can be read.

import { useEffect } from "react";
import { create } from "zustand";
import { onDaemonEvent, rpc } from "../lib/daemon";
import { EV, M } from "../lib/protocol";
import { nextRun, runExit, runHost, runTitle, runningLine, type SignInRun } from "../lib/signIns";
import { useStore } from "../lib/store";
import { useSync } from "../lib/syncStore";
import { disposeEntry } from "../lib/terminals";
import { TerminalPane } from "./TerminalPane";
import { Dialog, cx } from "./ui";

const useRunning = create<{ run: SignInRun | null }>(() => ({ run: null }));

let started = false;

export function startSignInRunning() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name !== EV.signinRunning || e.host !== "local") return;
    useRunning.setState((s) => ({ run: nextRun(s.run, e.data as SignInRun) }));
  });
}

export function SignInRunning() {
  const run = useRunning((s) => s.run);
  const central = useSync((s) => s.central);
  const hosts = useStore((s) => s.hosts);
  const tailnet = Object.values(hosts)
    .filter((h) => h.kind === "tailnet")
    .map((h) => h.id);
  const host = run ? runHost(run, central, tailnet) : null;
  const localExit = useStore((s) => (run && !run.member ? s.terminals.local?.[run.terminal]?.exit : undefined));
  const exit = run ? runExit(run, localExit ?? undefined) : undefined;
  const close = () => useRunning.setState({ run: null });
  useEffect(() => {
    if (exit && exit.code === 0) close();
  }, [exit]);
  // Another member's terminal is let go of once the window closes or
  // shows the next one.
  const remote = run?.member && host ? { host, terminal: run.terminal } : null;
  useEffect(() => {
    if (!remote) return;
    return () => {
      void rpc(remote.host, M.terminalDetach, { id: remote.terminal }).catch(() => {});
      disposeEntry(remote.host, remote.terminal);
    };
  }, [remote?.host, remote?.terminal]);
  if (!run) return null;
  const line = runningLine(exit);
  return (
    <Dialog title={runTitle(run)} width={720} onClose={close}>
      {line && <p className={cx("mb-2 ui-text-12", exit ? "text-error" : "text-muted")}>{line}</p>}
      <div className="h-[340px] overflow-hidden rounded-md border border-border bg-bg">
        {host ? (
          <TerminalPane host={host} session={run.terminal} wsId="" focused visible />
        ) : (
          <p className="p-3 ui-text-12 text-muted">This Mac is not connected to {central}, so the sign-in's terminal can't show here.</p>
        )}
      </div>
    </Dialog>
  );
}
