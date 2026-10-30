// A sign-in running on this Mac (X75), as Sign in on every member started
// it here: its terminal in a window, for any question it asks. Closes when
// it succeeds; a failure stays, so its output can be read.

import { useEffect } from "react";
import { create } from "zustand";
import { onDaemonEvent } from "../lib/daemon";
import { EV } from "../lib/protocol";
import { runningLine } from "../lib/signIns";
import { useStore } from "../lib/store";
import { TerminalPane } from "./TerminalPane";
import { Dialog, cx } from "./ui";

const useRunning = create<{ run: { terminal: number; name: string } | null }>(() => ({ run: null }));

let started = false;

export function startSignInRunning() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name !== EV.signinRunning || e.host !== "local") return;
    useRunning.setState({ run: e.data as { terminal: number; name: string } });
  });
}

export function SignInRunning() {
  const run = useRunning((s) => s.run);
  const exit = useStore((s) => (run ? s.terminals.local?.[run.terminal]?.exit : undefined));
  const close = () => useRunning.setState({ run: null });
  useEffect(() => {
    if (exit && exit.code === 0) close();
  }, [exit]);
  if (!run) return null;
  const line = runningLine(exit);
  return (
    <Dialog title={`Sign in: ${run.name}`} width={720} onClose={close}>
      {line && <p className={cx("mb-2 ui-text-12", exit ? "text-error" : "text-muted")}>{line}</p>}
      <div className="h-[340px] overflow-hidden rounded-md border border-border bg-bg">
        <TerminalPane host="local" session={run.terminal} wsId="" focused visible />
      </div>
    </Dialog>
  );
}
