// The project page's Heavy commands (X62): the `[heavy]` table, edited with
// the rest of the page and saved with its Save, and the approval that lets
// agents run its commands on whichever machine is free.

import { useCallback, useEffect, useId, useState } from "react";
import { Plus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { approvalBanner, entryStates, heavyChanged, heavyDraft, heavyFromDraft, secretWarning, type HeavyDraft } from "../../lib/heavyCommands";
import { approvalTargets, approveHeavy, readLinks } from "../../lib/heavyApproval";
import { M, type HeavyInfo, type HeavyOs, type LinkInfo, type ProjectIdentity } from "../../lib/protocol";
import { errorToast, toast, useStore } from "../../lib/store";
import { Button, IconButton, cx } from "../ui";
import { Card, Row, Section, Segmented, fieldCls } from "./controls";

const OS: readonly { id: HeavyOs; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

const EMPTY = heavyDraft(undefined);

/** The section's state, kept by the project page for its Save. */
export function useHeavy(host: string, id: string) {
  const [info, setInfo] = useState<HeavyInfo | null>(null);
  const [draft, setDraft] = useState<HeavyDraft>(EMPTY);
  const [orig, setOrig] = useState<HeavyDraft>(EMPTY);
  const show = (i: HeavyInfo) => {
    const d = heavyDraft(i.config);
    setInfo(i);
    setDraft(d);
    setOrig(d);
  };
  const load = useCallback(() => {
    void rpc<HeavyInfo>(host, M.heavyGet, { project: id }).then(show, () => setInfo(null));
  }, [host, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  const dirty = !!info && heavyChanged(orig, draft);
  const save = async () => {
    if (dirty) show(await rpc<HeavyInfo>(host, M.heavySet, { project: id, heavy: heavyFromDraft(draft) }));
  };
  return { info, draft, setDraft, dirty, save, discard: () => setDraft(orig), show, load };
}

export function HeavySection({
  host,
  id,
  project,
  heavy,
}: {
  host: string;
  id: string;
  project: { name: string; identity?: ProjectIdentity | null };
  heavy: ReturnType<typeof useHeavy>;
}) {
  const osId = useId();
  const hosts = useStore((s) => s.hosts);
  const [links, setLinks] = useState<Record<string, LinkInfo | null>>({});
  const [approving, setApproving] = useState(false);
  // Which machines take this host's heavy commands: the banner names them.
  const reached = Object.values(hosts)
    .filter((h) => h.remote && h.kind === "tailnet" && h.status === "connected")
    .map((h) => h.id)
    .join(",");
  useEffect(() => void readLinks(Object.values(useStore.getState().hosts)).then(setLinks), [reached]);
  const { info, draft, setDraft, dirty } = heavy;
  if (!info) return null;
  const host_label = host === "local" ? "this Mac" : (hosts[host]?.label ?? host);
  const states = new Map(entryStates(info).map((e) => [e.command, e.approved]));
  const banner = approvalBanner(
    info,
    approvalTargets(host, Object.values(hosts), links).map((t) => t.label),
  );
  const set = (patch: Partial<HeavyDraft>) => setDraft({ ...draft, ...patch });
  const secrets = heavyFromDraft(draft)
    .env.map(secretWarning)
    .filter((w): w is string => !!w);
  const approve = async () => {
    setApproving(true);
    try {
      const r = await approveHeavy(host, id, project, info, Object.values(hosts), await readLinks(Object.values(hosts)));
      heavy.show(r.info);
      toast(r.toast);
    } catch (e) {
      errorToast(e);
    } finally {
      setApproving(false);
    }
  };
  return (
    <Section title="Heavy commands" hint="Approved commands run without asking, on whichever machine is free.">
      <Card>
        <div data-setting="project-heavy" className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex flex-col gap-[3px]">
            <span className="ui-text-13">Commands</span>
            <span className="ui-text-12 text-muted">A Bash call that starts with one of these goes to the free worker with the lowest load. Chained, piped or redirected calls run where the agent is.</span>
          </div>
          {draft.commands.map((c, i) => {
            const approved = !!states.get(c.trim());
            return (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className={cx(fieldCls, "min-w-0 flex-1 font-mono ui-text-12.5")}
                  spellCheck={false}
                  aria-label="Heavy command"
                  value={c}
                  placeholder="pnpm test"
                  onChange={(e) => set({ commands: draft.commands.map((x, j) => (j === i ? e.target.value : x)) })}
                />
                <span className={cx("inline-flex h-[26px] w-[118px] shrink-0 items-center gap-1.5 rounded-md border px-2 ui-text-12", approved ? "border-border text-muted" : "border-[#6b5a1e] bg-[#2a2410] text-blocked")}>
                  <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", approved ? "bg-done" : "bg-blocked")} />
                  {approved ? "Approved" : "Not approved"}
                </span>
                <IconButton title={`Remove ${c || "command"}`} onClick={() => set({ commands: draft.commands.filter((_, j) => j !== i) })}>
                  <X size={14} />
                </IconButton>
              </div>
            );
          })}
          <Button size="sm" className="self-start" onClick={() => set({ commands: [...draft.commands, ""] })}>
            <Plus size={12} /> Add command
          </Button>
        </div>
        <Row setting="project-heavy-os" label="Runs on" labelId={osId} hint="Workers on another system are skipped.">
          <Segmented value={draft.os} options={OS} onChange={(os) => set({ os })} labelledBy={osId} />
        </Row>
        <Row setting="project-heavy-outputs" label="Bring back after a run" htmlFor="settings-p-outputs" hint={`Ignored paths that replace the same paths on ${host_label} when a run ends. Up to 1 GiB.`}>
          <input id="settings-p-outputs" className={cx(fieldCls, "w-[240px] font-mono ui-text-12.5")} spellCheck={false} value={draft.outputs} placeholder="coverage" onChange={(e) => set({ outputs: e.target.value })} />
        </Row>
        <Row
          setting="project-heavy-env"
          label="Pass to the worker"
          htmlFor="settings-p-env"
          hint={
            secrets.length ? (
              <span className="flex flex-col gap-0.5 text-blocked">
                {secrets.map((w) => (
                  <span key={w} className="flex items-start gap-1.5">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    {w}
                  </span>
                ))}
              </span>
            ) : (
              "Variable names whose values reach the worker."
            )
          }
        >
          <input id="settings-p-env" className={cx(fieldCls, "w-[240px] font-mono ui-text-12.5")} spellCheck={false} value={draft.env} placeholder="CI" onChange={(e) => set({ env: e.target.value })} />
        </Row>
        {info.error && <div className="px-4 py-3 ui-text-12.5 text-error">{info.error}</div>}
        {banner && (
          <div className="flex items-center gap-3.5 bg-[#211a14] px-4 py-3.5">
            <ShieldCheck size={16} className="shrink-0 text-blocked" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="ui-text-13 font-medium">{banner.title}</span>
              <span className="ui-text-12 text-muted">{dirty ? "Save first: the list you approve is the saved one." : banner.text}</span>
            </div>
            <Button variant="primary" disabled={dirty || approving || !!info.error} onClick={() => void approve()}>
              Approve
            </Button>
          </div>
        )}
      </Card>
      <span className="px-0.5 ui-text-12 text-muted">Changing an entry needs approving again. Removing one doesn't. Only this app and paired desktops can approve, never an agent or a phone.</span>
    </Section>
  );
}
