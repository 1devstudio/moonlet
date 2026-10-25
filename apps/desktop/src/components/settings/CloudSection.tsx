// The project page's Cloud workers (X63): which provider, machine type,
// location and image the central host rents for this project, saved with
// the page's Save to the central host's `cloud.json`. Shown on the central
// host's projects only.

import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { imageOptions, locationOptions, machineTypeLabel, type Offered, projectCloudChange, projectCloudDraft, projectCloudErrors, projectCloudFooter, projectCloudKey, type ProjectCloudDraft } from "../../lib/cloudSettings";
import { useCloud } from "../../lib/cloudStore";
import { M, type CloudImage, type CloudInfo, type CloudLocation, type MachineType, type ProjectIdentity } from "../../lib/protocol";
import { goSettings } from "../../lib/settingsNavigation";
import { errorToast, toast } from "../../lib/store";
import { Button, cx } from "../ui";
import { Card, Row, Section, Status, SwitchRow, fieldCls } from "./controls";

/** A provider's list, or why it could not be read. */
interface Listed<T> {
  list: T[];
  error?: string;
}

const listed = <T,>(host: string, method: string, params: object): Promise<Listed<T>> =>
  rpc<T[]>(host, method, params).then(
    (list) => ({ list }),
    (e) => ({ list: [], error: e instanceof Error ? e.message : String(e) }),
  );

/** Provider `provider`'s locations and images, and its machine types at `location`. */
function useProviderLists(host: string, provider: string, location: string) {
  const [types, setTypes] = useState<Listed<MachineType> | null>(null);
  const [locations, setLocations] = useState<Listed<CloudLocation> | null>(null);
  const [images, setImages] = useState<Listed<CloudImage> | null>(null);
  useEffect(() => {
    setLocations(null);
    setImages(null);
    if (!provider) return;
    let live = true;
    void listed<CloudLocation>(host, M.cloudLocations, { provider }).then((l) => live && setLocations(l));
    void listed<CloudImage>(host, M.cloudImages, { provider }).then((l) => live && setImages(l));
    return () => {
      live = false;
    };
  }, [host, provider]);
  useEffect(() => {
    setTypes(null);
    if (!provider || !location) return;
    let live = true;
    void listed<MachineType>(host, M.cloudTypes, { provider, location }).then((l) => live && setTypes(l));
    return () => {
      live = false;
    };
  }, [host, provider, location]);
  return { types, locations, images };
}

/** The lists the errors check against: only those read without an error. */
const offered = (l: ReturnType<typeof useProviderLists>): Offered => ({
  types: l.types && !l.types.error ? l.types.list : null,
  images: l.images && !l.images.error ? l.images.list : null,
});

/** The section's state, kept by the project page for its Save. */
export function useProjectCloud(host: string, identity: ProjectIdentity | null | undefined) {
  const central = useCloud((s) => s.host) === host;
  const key = identity ? projectCloudKey(identity) : null;
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [draft, setDraft] = useState<ProjectCloudDraft | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const show = useCallback(
    (i: CloudInfo) => {
      setInfo(i);
      if (key) setDraft(projectCloudDraft(i, key));
    },
    [key],
  );
  useEffect(() => {
    // Another project's draft never shows under this one's key.
    setInfo(null);
    setDraft(null);
    if (!central || !key) return;
    let live = true;
    setFailed(null);
    void rpc<CloudInfo>(host, M.cloudGet).then(
      (i) => live && show(i),
      (e) => {
        if (!live) return;
        setInfo(null);
        setFailed(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [central, host, key, show]);
  const lists = useProviderLists(host, draft?.provider ?? "", draft?.location.trim() ?? "");
  const shown = central && !!key && !!info && !!draft;
  const change = shown ? projectCloudChange(info, key, draft) : null;
  const errors = shown && draft ? projectCloudErrors(draft, offered(lists)) : {};
  const save = async () => {
    if (change) show(await rpc<CloudInfo>(host, M.cloudSet, change));
  };
  return {
    shown,
    /** Why the central host's cloud settings could not be read, on its own project. */
    failed: central && key ? failed : null,
    key,
    info,
    draft,
    setDraft,
    lists,
    dirty: !!change,
    errors: Object.keys(errors).length,
    save,
    discard: () => info && key && setDraft(projectCloudDraft(info, key)),
  };
}

export function CloudSection({ host, project, cloud, machineSetup }: { host: string; project: { id: string; name: string }; cloud: ReturnType<typeof useProjectCloud>; machineSetup?: string | null }) {
  const machines = useCloud((s) => s.machines);
  const { info, draft, setDraft } = cloud;
  const { types, locations, images } = cloud.lists;
  const [starting, setStarting] = useState(false);
  const provider = draft?.provider ?? "";
  const location = draft?.location.trim() ?? "";
  if (cloud.failed)
    return (
      <Section title="Cloud workers">
        <Card>
          <div className="px-4 py-3.5">
            <Status line={{ tone: "error", text: `Could not read the cloud settings: ${cloud.failed}` }} />
          </div>
        </Card>
      </Section>
    );
  if (!cloud.shown || !info || !draft) return null;
  const errors = projectCloudErrors(draft, offered(cloud.lists));
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
  const arch = typeOptions.find((t) => t.name === draft.type)?.arch ?? "";

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
            <Row label="Location" htmlFor="project-cloud-location" hint={locations?.error ? <span className="text-error">{locations.error}</span> : hint("Where the provider makes the machines.", errors.location)}>
              <select id="project-cloud-location" aria-invalid={!!errors.location} className={cx(fieldCls, "w-[260px]")} value={draft.location} onChange={(e) => set({ location: e.target.value })}>
                <option value="">{locations ? "Pick a location…" : "Loading…"}</option>
                {locationOptions(locations?.list ?? null, draft.location).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Machine type" htmlFor="project-cloud-type" hint={types?.error ? <span className="text-error">{types.error}</span> : hint(`${kind?.label ?? "The provider"}'s types in this location.`, errors.type)}>
              <select id="project-cloud-type" aria-invalid={!!errors.type} disabled={!location} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} value={draft.type} onChange={(e) => set({ type: e.target.value })}>
                <option value="">{location ? (types ? "Pick a type…" : "Loading…") : "Pick a location first"}</option>
                {typeOptions.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.cores ? machineTypeLabel(t) : t.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Image" htmlFor="project-cloud-image" hint={images?.error ? <span className="text-error">{images.error}</span> : hint(arch ? `The provider's images for ${arch} machines, and your project's snapshots.` : "Images depend on the machine type's architecture.", errors.image)}>
              <select id="project-cloud-image" aria-invalid={!!errors.image} disabled={!draft.type} className={cx(fieldCls, "w-[260px]")} value={draft.image} onChange={(e) => set({ image: e.target.value })}>
                <option value="">{draft.type ? (images ? "Pick an image…" : "Loading…") : "Pick a machine type first"}</option>
                {imageOptions(images?.list ?? null, arch, draft.image).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
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
