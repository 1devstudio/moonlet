// The workspace chip at the top of Inbox and Sessions. A workspace the
// members of one account share shows once, as in the desktop's switcher, and
// Merge with… joins two of them (X68).

import { Fragment, useRef, useState } from "react";
import { Check, ChevronDown, Merge } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { confirmView, type ConfirmOptions } from "@desktop/lib/confirmOptions";
import { M, type ProfileInfo } from "@desktop/lib/protocol";
import { colorHex, mergeHost } from "@desktop/lib/workspaces";
import { updateSettings, useApp, useShownWorkspace } from "../lib/app";
import { hostWorkspaces, isChosen, mergeAsk, mergeChoices, workspaceChoices, type WorkspaceChoice } from "../lib/workspaceChoices";
import { Sheet } from "./Sheet";
import { Btn, cx } from "./ui";

type Step = { kind: "pick" } | { kind: "merge" } | { kind: "confirm"; from: WorkspaceChoice; into: WorkspaceChoice; host: string; prompt: ConfirmOptions };

export function WorkspacePill() {
  const data = useApp((s) => s.data);
  const hosts = useApp((s) => s.hosts);
  const shown = useShownWorkspace();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each target picked numbers its profile lookup; only the latest may ask.
  const asking = useRef(0);
  const choices = workspaceChoices(hostWorkspaces(hosts, data));
  const current = choices.find((c) => isChosen(c.ref, shown));
  const targets = current ? mergeChoices(choices, current) : [];
  // A merge on its way cannot be called back, so the sheet stays until it ends.
  const close = () => {
    if (busy) return;
    asking.current++;
    setOpen(false);
    setStep({ kind: "pick" });
    setError(null);
  };

  const ask = async (into: WorkspaceChoice) => {
    if (!current) return;
    const from = current;
    const turn = ++asking.current;
    // The question names what a new Claude profile does, in the terms of the
    // member asked; without its profiles it leaves that out.
    const profiles = await rpc<ProfileInfo[]>(mergeHost(from.row, into.row), M.profileList).catch(() => null);
    // Backed out, closed or picked another target meanwhile.
    if (turn !== asking.current) return;
    setStep({ kind: "confirm", from, into, ...mergeAsk(from, into, data, profiles) });
  };

  // Merges the workspace the question named, whatever is shown since.
  const merge = async (s: Extract<Step, { kind: "confirm" }>) => {
    setBusy(true);
    setError(null);
    try {
      await rpc(s.host, M.workspaceMerge, { id: s.from.ref.id, into: s.into.ref.id });
      updateSettings({ workspace: s.into.ref });
      setOpen(false);
      setStep({ kind: "pick" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-9 items-center gap-[7px] rounded-[18px] border border-border-strong bg-panel px-3 text-[13.5px]">
        <span className="h-2 w-2 rounded-full" style={{ background: current ? colorHex(current.color) : "var(--color-muted)" }} />
        {current?.name ?? "All workspaces"}
        {/* Two of one name in one account (X68): which one is chosen. */}
        {current?.from && <span className="max-w-[96px] truncate text-[12px] text-faint">from {current.from}</span>}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <Sheet label={step.kind === "pick" ? "Workspace" : "Merge workspaces"} onClose={close}>
          {step.kind === "pick" && (
            <div className="flex flex-col px-2 pb-2">
              {[{ ref: null, name: "All workspaces", color: null, from: null, hostLabel: null }, ...choices].map((c) => (
                <Fragment key={c.ref ? `${c.ref.account}/${c.ref.id}` : ""}>
                  {c.hostLabel && <div className="eyebrow px-3 pt-3 pb-1">{c.hostLabel}</div>}
                  <button
                    type="button"
                    onClick={() => {
                      updateSettings({ workspace: c.ref });
                      close();
                    }}
                    className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]"
                  >
                    <ChoiceLine c={c} />
                    {isChosen(c.ref, shown) && <Check size={16} className="text-accent" />}
                  </button>
                </Fragment>
              ))}
              {targets.length > 0 && (
                <button type="button" onClick={() => setStep({ kind: "merge" })} className="mt-1 flex min-h-12 items-center gap-3 rounded-[10px] border-t border-border px-3 text-left text-[15px] text-muted">
                  <Merge size={16} /> Merge with…
                </button>
              )}
            </div>
          )}
          {step.kind === "merge" && (
            <div className="flex flex-col px-2 pb-2">
              <div className="eyebrow px-3 pt-1 pb-1">Merge {current?.name} into</div>
              {targets.map((c) => (
                <button key={`${c.ref.account}/${c.ref.id}`} type="button" onClick={() => void ask(c)} className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]">
                  <ChoiceLine c={c} />
                </button>
              ))}
              <Btn
                tone="ghost"
                onClick={() => {
                  asking.current++;
                  setStep({ kind: "pick" });
                }}
              >
                Back
              </Btn>
            </div>
          )}
          {step.kind === "confirm" && (
            <div className="flex flex-col gap-3 px-4 pt-1 pb-2">
              <span className="text-[16px] font-semibold">{step.prompt.title}</span>
              <p className="text-[14px] leading-[1.45] text-muted">{confirmView(step.prompt, false).message}</p>
              {error && <span className="text-[12.5px] text-error">{error}</span>}
              <Btn tone="primary" disabled={busy} onClick={() => void merge(step)}>
                <Merge size={16} /> {step.prompt.action}
              </Btn>
              <Btn tone="ghost" disabled={busy} onClick={close}>
                Cancel
              </Btn>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

function ChoiceLine({ c }: { c: { name: string; color: WorkspaceChoice["color"] | null; from: string | null } }) {
  return (
    <>
      <span className={cx("h-2.5 w-2.5 flex-none rounded-full", !c.color && "border border-muted")} style={c.color ? { background: colorHex(c.color) } : undefined} />
      <span className="flex-1">
        {c.name}
        {c.from && <span className="ml-2 text-[12.5px] text-faint">from {c.from}</span>}
      </span>
    </>
  );
}
