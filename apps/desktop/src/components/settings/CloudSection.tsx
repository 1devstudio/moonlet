// The project page's Cloud workers (X63): which provider, machine type,
// location and image the central host rents for this project, saved with
// the page's Save to the central host's `cloud.json`. Shown on the central
// host's projects only.

import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { machineTypeLabel, projectCloudChange, projectCloudDraft, projectCloudErrors, projectCloudFooter, projectCloudKey, type ProjectCloudDraft } from "../../lib/cloudSettings";
import { useCloud } from "../../lib/cloudStore";
import { M, type CloudInfo, type MachineType, type ProjectIdentity } from "../../lib/protocol";
import { goSettings } from "../../lib/settingsNavigation";
import { errorToast, toast } from "../../lib/store";
import { Button, cx } from "../ui";
import { Card, Row, Section, Status, SwitchRow, fieldCls } from "./controls";

/** The section's state, kept by the project page for its Save. */
export function useProjectCloud(host: string, identity: ProjectIdentity | null | undefined) {
  const central = useCloud((s) => s.host) === host;
  const key = identity ? projectCloudKey(identity) : null;
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [draft, setDraft] = useState<ProjectCloudDraft | null>(null);
  const show = useCallback(
    (i: CloudInfo) => {
      setInfo(i);
      if (key) setDraft(projectCloudDraft(i, key));
    },
    [key],
  );
  useEffect(() => {
    if (!central || !key) return;
    let live = true;
    void rpc<CloudInfo>(host, M.cloudGet).then(
      (i) => live && show(i),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [central, host, key, show]);
  const shown = central && !!key && !!info && !!draft;
  const change = shown ? projectCloudChange(info, key, draft) : null;
  const errors = shown && draft ? projectCloudErrors(draft) : {};
  const save = async () => {
    if (change) show(await rpc<CloudInfo>(host, M.cloudSet, change));
  };
  return {
    shown,
    key,
    info,
    draft,
    setDraft,
    dirty: !!change,
    errors: Object.keys(errors).length,
    save,
    discard: () => info && key && setDraft(projectCloudDraft(info, key)),
  };
}

export function CloudSection({ host, project, cloud, machineSetup }: { host: string; project: { id: string; name: string }; cloud: ReturnType<typeof useProjectCloud>; machineSetup?: string | null }) {
  const machines = useCloud((s) => s.machines);
  const { info, draft, setDraft } = cloud;
  const [types, setTypes] = useState<{ list: MachineType[]; error?: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const provider = draft?.provider ?? "";
  const location = draft?.location.trim() ?? "";
  useEffect(() => {
    setTypes(null);
    if (!provider || !location) return;
    let live = true;
    // Typing a location asks once it settles.
    const t = setTimeout(
      () =>
        void rpc<MachineType[]>(host, M.cloudTypes, { provider, location }).then(
          (list) => live && setTypes({ list }),
          (e) => live && setTypes({ list: [], error: e instanceof Error ? e.message : String(e) }),
        ),
      300,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [host, provider, location]);
  if (!cloud.shown || !info || !draft) return null;
  const errors = projectCloudErrors(draft);
  const set = (patch: Partial<ProjectCloudDraft>) => setDraft({ ...draft, ...patch });
  const name = host === "local" ? "this Mac" : host;
  const configured = info.kinds.filter((k) => info.providers[k.id]);
  const kind = info.kinds.find((k) => k.id === provider);
  const saved = !!cloud.key && !!info.projects[cloud.key];
  const all = machines?.machines ?? [];
  const start = async () => {
    setStarting(true);
    try {
      const m = await rpc<{ name: string }>(host, M.cloudUp, { project: project.id });
      toast(`Starting ${m.name}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setStarting(false);
    }
  };
  // A type that is saved but not offered in this location stays listed.
  const typeOptions = types?.list.some((t) => t.name === draft.type) || !draft.type ? (types?.list ?? []) : [...(types?.list ?? []), { name: draft.type, cores: 0, memory_gb: 0, arch: "" }];
  const hint = (text: string, error?: string) => (error ? <span className="text-error">{error}</span> : text);

  return (
    <Section
      title="Cloud workers"
      hint={
        <>
          Machines {name} rents to run {project.name}'s heavy commands. Tokens and limits are in{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => void goSettings({ page: "cloud" })}>
            Settings › Machines › Cloud workers
          </button>
          .
        </>
      }
    >
      <Card>
        <div data-setting="project-cloud">
          <SwitchRow
            label="Use cloud machines when every worker is busy"
            hint={`The command still runs on ${name}. A machine starts and takes the next one.`}
            on={draft.overflow}
            disabled={!provider}
            onChange={(overflow) => set({ overflow })}
          />
        </div>
        <p className="m-0 px-4 py-3 ui-text-12 text-muted">Cloud machines get every tracked file of the session, and untracked files that are not ignored. Remove secrets from the files, not only from the history.</p>
        <Row label="Provider" htmlFor="project-cloud-provider" hint={configured.length ? undefined : "Add a provider in Settings › Machines › Cloud workers first."}>
          <select id="project-cloud-provider" className={cx(fieldCls, "w-[260px]")} value={provider} onChange={(e) => set({ provider: e.target.value, overflow: e.target.value ? draft.overflow : false })}>
            <option value="">None</option>
            {configured.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Row>
        {provider && (
          <>
            <Row label="Location" htmlFor="project-cloud-location" hint={hint("Where the provider makes the machines, such as fsn1.", errors.location)}>
              <input id="project-cloud-location" aria-invalid={!!errors.location} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} spellCheck={false} value={draft.location} onChange={(e) => set({ location: e.target.value })} />
            </Row>
            <Row label="Machine type" htmlFor="project-cloud-type" hint={types?.error ? <span className="text-error">{types.error}</span> : hint(`${kind?.label ?? "The provider"}'s types in this location.`, errors.type)}>
              <select id="project-cloud-type" aria-invalid={!!errors.type} disabled={!location} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} value={draft.type} onChange={(e) => set({ type: e.target.value })}>
                <option value="">{location ? (types ? "Pick a type…" : "Loading…") : "Name a location first"}</option>
                {typeOptions.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.cores ? machineTypeLabel(t) : t.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Image" htmlFor="project-cloud-image" hint={hint("An image name, or the id of an image in your provider project.", errors.image)}>
              <input id="project-cloud-image" aria-invalid={!!errors.image} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} spellCheck={false} value={draft.image} onChange={(e) => set({ image: e.target.value })} />
            </Row>
            <Row label="Machine setup" hint="From [heavy] machine_setup. Runs as root on each new machine, after moonlet pairs it.">
              <span className="font-mono ui-text-12.5 text-muted">{machineSetup || "None"}</span>
            </Row>
          </>
        )}
        <div className="flex items-center gap-3 px-4 py-3">
          <Status line={{ tone: all.some((m) => m.project_key === cloud.key) ? "done" : "muted", text: projectCloudFooter(all, cloud.key ?? "", project.name) }} className="flex-1" />
          <button type="button" className="ui-text-12 text-accent hover:underline" onClick={() => void goSettings({ page: "workers" })}>
            Workers
          </button>
          <Button size="sm" disabled={!saved || cloud.dirty || starting} title={!saved || cloud.dirty ? "Save the project's cloud setting first" : undefined} onClick={() => void start()}>
            <Play size={12} /> Start a machine
          </Button>
        </div>
      </Card>
    </Section>
  );
}
