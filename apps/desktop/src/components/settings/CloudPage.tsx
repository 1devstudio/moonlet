// Settings › Machines › Cloud workers (X63): the central host's providers,
// its Tailscale OAuth client and the limits, saved to its `cloud.json`.
// Secrets are never read back: a saved one shows "Saved" with Replace.

import { useEffect, useState } from "react";
import { Cloud, Copy, Lock, Plus, TriangleAlert } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { rpc } from "../../lib/daemon";
import {
  afterRemoving,
  cloudChanges,
  cloudDraft,
  cloudErrors,
  policyAddress,
  policySnippet,
  reachWarning,
  providerForm,
  providerName,
  providerStatus,
  removalError,
  removeProviderPrompt,
  usageLine,
  type CloudDraft,
} from "../../lib/cloudSettings";
import { loadCloud, retryRemoval, useCloud } from "../../lib/cloudStore";
import { saveBarStatus } from "../../lib/projectSettings";
import { goSettings } from "../../lib/settingsNavigation";
import { M, type CloudInfo, type MobileStatus } from "../../lib/protocol";
import { errorToast, toast, useStore } from "../../lib/store";
import { Button, cx } from "../ui";
import { Card, PageBody, PageHeading, Row, SaveBar, Section, Status, fieldCls } from "./controls";
import { useUnsaved } from "./useUnsaved";

function Badge({ children }: { children: string }) {
  return <span className="inline-flex h-[18px] items-center rounded bg-raised px-1.5 ui-text-11.5 font-normal text-muted">{children}</span>;
}

/** A secret field: "Saved" with Replace until replaced, then an input. */
function SecretField({ id, saved, value, onChange, label }: { id: string; saved: boolean; value: string; onChange: (v: string) => void; label: string }) {
  const [replacing, setReplacing] = useState(false);
  if (saved && !replacing && !value)
    return (
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 ui-text-12.5 text-muted">
          <Lock size={12} /> Saved
        </span>
        <Button size="sm" aria-label={`Replace ${label}`} onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </span>
    );
  return <input id={id} type="password" autoFocus={replacing} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function NumberField({ id, value, onChange, unit, error }: { id: string; value: string; onChange: (v: string) => void; unit: string; error?: string }) {
  return (
    <span className="flex items-center gap-2">
      <input id={id} inputMode="numeric" aria-invalid={!!error} className={cx(fieldCls, "w-[64px] text-right font-mono ui-text-12.5")} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="ui-text-12.5 text-muted">{unit}</span>
    </span>
  );
}

const hint = (text: string, error?: string) => (error ? <span className="text-error">{error}</span> : text);

export function CloudPage() {
  const host = useCloud((s) => s.host);
  const machines = useCloud((s) => s.machines);
  const hostLabel = useStore((s) => s.hosts[host]?.label);
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [draft, setDraft] = useState<CloudDraft | null>(null);
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Re-renders the secret fields, so Replace closes after Save and Discard.
  const [generation, setGeneration] = useState(0);

  const show = (i: CloudInfo) => {
    setInfo(i);
    setDraft(cloudDraft(i));
    setGeneration((g) => g + 1);
  };
  useEffect(() => {
    setInfo(null);
    setFailed(null);
    // A late answer for a host no longer shown is dropped: Save goes to `host`.
    let live = true;
    void rpc<CloudInfo>(host, M.cloudGet).then(
      (i) => live && show(i),
      (e) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    void rpc<MobileStatus>(host, M.mobileStatus).then(
      (st) => live && setStatus(st),
      () => live && setStatus(null),
    );
    loadCloud();
    return () => {
      live = false;
    };
  }, [host]);

  const name = status?.host || hostLabel || host;
  const changes = info && draft ? cloudChanges(info, draft) : null;
  const errors = draft ? cloudErrors(draft, info ?? undefined) : {};
  const errorCount = Object.keys(errors).length;
  const dirty = !!changes;
  const canSave = dirty && !errorCount && !saving;

  const save = async () => {
    if (!canSave || !changes) return;
    setSaving(true);
    try {
      show(await rpc<CloudInfo>(host, M.cloudSet, changes));
      toast("Saved cloud workers settings");
    } catch (e) {
      errorToast(e);
    } finally {
      setSaving(false);
    }
  };
  useUnsaved({ dirty, saving, message: "Discard unsaved changes to Cloud workers?" }, () => void save());

  const set = (patch: Partial<CloudDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setField = (provider: string, field: string, value: string) => set({ providers: { ...draft!.providers, [provider]: { ...draft!.providers[provider], [field]: value } } });
  const all = [...(machines?.machines ?? [])];

  const removeProvider = async (id: string, label: string) => {
    if (!info?.providers[id]) {
      // Added on this page, not saved yet.
      const { [id]: _, ...rest } = draft!.providers;
      return set({ providers: rest });
    }
    const count = all.filter((m) => m.provider === id).length;
    if (!(await askConfirm(removeProviderPrompt(label, count, name)))) return;
    try {
      const next = await rpc<CloudInfo>(host, M.cloudSet, { providers: { [id]: null } });
      // The other unsaved edits stay for Save or Discard.
      setInfo(next);
      setDraft((d) => (d ? afterRemoving(d, next, id) : d));
    } catch (e) {
      errorToast(e);
    }
  };

  const heading = (
    <PageHeading
      title={
        <span className="flex items-center gap-2.5">
          Cloud workers
          <Badge>{`${name} · Central host`}</Badge>
        </span>
      }
    >
      {name} rents machines for heavy commands when its workers are busy, and removes them once they sit idle. A cloud machine only runs commands: agents and sessions stay on {name}.
    </PageHeading>
  );

  if (!info || !draft)
    return (
      <PageBody>
        {heading}
        <span className="ui-text-12.5 text-muted">{failed ? `Could not read ${name}'s cloud settings: ${failed}` : "Loading…"}</span>
      </PageBody>
    );

  const addable = info.kinds.filter((k) => !draft.providers[k.id]);
  const usage = usageLine(machines?.hours_this_month ?? 0, info.max_hours_month);
  const addr = policyAddress(status ?? { port: 47428, listening: [] }, name);
  const snippet = policySnippet(draft.tailscale.tag.trim() || info.tailscale.tag, addr);
  const port = addr.split(":").pop();
  const unreachable = status && reachWarning(status, name);
  const bar = saveBarStatus({ dirty, errors: errorCount });

  return (
    <PageBody
      bar={
        <SaveBar dirty={dirty} canSave={canSave} onDiscard={() => show(info)} onSave={() => void save()}>
          <span className="truncate font-mono ui-text-11.5 text-faint">~/.moonlet/cloud.json on {name}</span>
          {(dirty || errorCount > 0) && <Status line={bar} />}
        </SaveBar>
      }
    >
      {heading}
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
        <Section title="Providers">
          <Card>
            {info.kinds
              .filter((k) => draft.providers[k.id])
              .map((kind) => {
                const form = providerForm(kind, info.providers[kind.id]);
                const failing = all.filter((m) => m.provider === kind.id).map((m) => ({ m, e: removalError(m, providerName(m.provider)) }));
                return (
                  <div key={`${kind.id}-${generation}`} data-setting={`cloud-provider-${kind.id}`} className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border">
                    <div className="flex items-center gap-3.5 px-4 py-3.5">
                      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                        <Cloud size={16} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="ui-text-13 font-medium">{kind.label}</span>
                        <Status line={{ tone: info.providers[kind.id] ? "done" : "muted", text: info.providers[kind.id] ? providerStatus(kind.id, all) : "Not saved yet" }} />
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void removeProvider(kind.id, kind.label)}>
                        Remove
                      </Button>
                    </div>
                    {form.rows.map((r) => {
                      const id = `cloud-${kind.id}-${r.name}`;
                      const value = draft.providers[kind.id]?.[r.name] ?? "";
                      return (
                        <Row key={r.name} label={r.label} hint={hint(r.help, errors[`${kind.id}.${r.name}`])} htmlFor={id}>
                          {r.secret ? (
                            <SecretField id={id} label={r.label} saved={r.saved} value={value} onChange={(v) => setField(kind.id, r.name, v)} />
                          ) : (
                            <input id={id} className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} spellCheck={false} value={value} onChange={(e) => setField(kind.id, r.name, e.target.value)} />
                          )}
                        </Row>
                      );
                    })}
                    {failing.map(
                      ({ m, e }) =>
                        e && (
                          <div key={m.id} className="flex items-center gap-3 bg-[#1c1213] px-4 py-3">
                            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" />
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="ui-text-12.5 text-error">{e.text}</span>
                              <span className="ui-text-12 text-muted">{e.detail}</span>
                            </div>
                            <Button size="sm" onClick={() => retryRemoval(host, m.id)}>
                              Retry
                            </Button>
                          </div>
                        ),
                    )}
                  </div>
                );
              })}
            <div className="flex items-center gap-3 px-4 py-3">
              {addable.length > 0 ? (
                <select
                  aria-label="Add provider"
                  className={cx(fieldCls, "w-[180px]")}
                  value=""
                  onChange={(e) => {
                    const kind = info.kinds.find((k) => k.id === e.target.value);
                    if (kind) set({ providers: { ...draft.providers, [kind.id]: Object.fromEntries(kind.fields.map((f) => [f.name, ""])) } });
                  }}
                >
                  <option value="">Add provider…</option>
                  {addable.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Button size="sm" disabled>
                  <Plus size={12} /> Add provider
                </Button>
              )}
              <span className="ui-text-12 text-muted">{info.kinds.length === 1 ? `${info.kinds[0].label} is the only provider so far.` : ""}</span>
            </div>
          </Card>
        </Section>

        <Section title="Tailscale" hint={`Each machine joins your tailnet with a one-off key that ${name} makes from this OAuth client. The secret never leaves ${name}.`}>
          <Card key={`tailscale-${generation}`}>
            <Row setting="cloud-tailscale" label="OAuth client ID" hint="Needs the auth_keys scope and the tag below." htmlFor="cloud-ts-id">
              <input id="cloud-ts-id" className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")} spellCheck={false} value={draft.tailscale.client_id} onChange={(e) => set({ tailscale: { ...draft.tailscale, client_id: e.target.value } })} />
            </Row>
            <Row label="OAuth client secret" htmlFor="cloud-ts-secret">
              <SecretField
                id="cloud-ts-secret"
                label="OAuth client secret"
                saved={info.tailscale.has_client_secret}
                value={draft.tailscale.client_secret}
                onChange={(v) => set({ tailscale: { ...draft.tailscale, client_secret: v } })}
              />
            </Row>
            <Row label="Tag" hint={hint("Every cloud machine gets it.", errors.tag)} htmlFor="cloud-ts-tag">
              <input
                id="cloud-ts-tag"
                aria-invalid={!!errors.tag}
                className={cx(fieldCls, "w-[260px] font-mono ui-text-12.5")}
                spellCheck={false}
                value={draft.tailscale.tag}
                onChange={(e) => set({ tailscale: { ...draft.tailscale, tag: e.target.value } })}
              />
            </Row>
            <div data-setting="cloud-policy" className="flex flex-col gap-2.5 px-4 py-3.5">
              {unreachable && (
                <span className="flex items-start gap-2 ui-text-12.5 text-blocked">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  <span className="flex-1">{unreachable}</span>
                  <Button size="sm" onClick={() => void goSettings({ page: "hosts", focus: "tailnet" })}>
                    Open Hosts
                  </Button>
                </span>
              )}
              <span className="flex items-center gap-2 ui-text-12.5 text-muted">
                <span className="flex-1">
                  Add this to your tailnet policy, so the tag reaches {name}'s port {port} and nothing else.
                </span>
                <Button size="sm" variant="ghost" aria-label="Copy the policy" onClick={() => void navigator.clipboard.writeText(snippet).then(() => toast("Copied the policy"))}>
                  <Copy size={12} />
                </Button>
              </span>
              <pre className="m-0 overflow-x-auto rounded-md border border-border bg-panel-2 px-3 py-2.5 font-mono ui-text-12">{snippet}</pre>
            </div>
          </Card>
        </Section>

        <Section title="Idle time and limits" hint="Agents can start machines with moonlet worker up, but only you can change these.">
          <Card>
            <Row setting="cloud-idle" label="Remove a machine after" hint={hint("With 0, a machine goes as soon as its command ends.", errors.idle_minutes)} htmlFor="cloud-idle">
              <NumberField id="cloud-idle" value={draft.idle_minutes} onChange={(v) => set({ idle_minutes: v })} unit="minutes idle" error={errors.idle_minutes} />
            </Row>
            <Row setting="cloud-max" label="At most" hint={hint("Counts machines that are being created, starting, ready or being removed.", errors.max_machines)} htmlFor="cloud-max">
              <NumberField id="cloud-max" value={draft.max_machines} onChange={(v) => set({ max_machines: v })} unit="machines" error={errors.max_machines} />
            </Row>
            <div data-setting="cloud-hours" className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center gap-6">
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <label htmlFor="cloud-hours" className="ui-text-13">
                    Monthly limit
                  </label>
                  <span className="ui-text-12 text-muted">{hint("From each create call to its confirmed removal, per calendar month (UTC).", errors.max_hours_month)}</span>
                </div>
                <NumberField id="cloud-hours" value={draft.max_hours_month} onChange={(v) => set({ max_hours_month: v })} unit="machine-hours" error={errors.max_hours_month} />
              </div>
              <span className="h-1 overflow-hidden rounded-full bg-raised">
                <span className={cx("block h-full rounded-full", usage.fraction >= 1 ? "bg-error" : "bg-accent")} style={{ width: `${Math.round(usage.fraction * 100)}%` }} />
              </span>
              <span data-setting="cloud-usage" className="ui-text-12 text-muted">
                {usage.text}
              </span>
            </div>
          </Card>
        </Section>
      </fieldset>
    </PageBody>
  );
}
