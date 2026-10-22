// Settings › Machines (X43): this Mac and the remote hosts, over the tailnet
// (X57) or SSH (R1, R2), and the phones paired with this Mac (X39).

import { useEffect, useId, useState } from "react";
import { encode } from "uqr";
import { Check, Copy, Laptop, Plus, Server, Smartphone, SquareTerminal, Trash2 } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { hostsApi, onDaemonEvent, onHostStatus, rpc } from "../../lib/daemon";
import { countdown, deviceLine, devicesOfKind, pairEndedText } from "../../lib/mobile";
import { addHostReady, displayCode, readAddHostInput } from "../../lib/addHost";
import { EV, M, type HostInfo, type LinkInfo, type MobilePairing, type MobileStatus } from "../../lib/protocol";
import { errorToast, toast, useStore } from "../../lib/store";
import { hostActions, hostLine, phoneAccessLine, removeAsks, updateCommand } from "../../lib/settingsPage";
import { Button, Dialog, Field, IconButton, cx, inputCls } from "../ui";
import { centralHostId, linkLine, linkRetries, pickCentral, watchLink } from "../../lib/workerLink";
import { Card, PageHeading, Row, Section, Status, Switch, SwitchRow } from "./controls";

const iconBox = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted";

function HostRow({ host, sessions, children }: { host: HostInfo; sessions: number; children?: React.ReactNode }) {
  const appVersion = useStore((s) => s.appVersion) ?? "";
  const command = updateCommand(host, appVersion);
  return (
    <div data-setting={`host-${host.id}`} className="flex items-center gap-3.5 px-4 py-3.5">
      <span aria-hidden="true" className={iconBox}>
        {host.remote ? <Server size={16} /> : <SquareTerminal size={16} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 ui-text-13 font-medium">
          {host.id}
          {host.kind === "tailnet" && <span className="rounded bg-raised px-1.5 py-px ui-text-11 font-normal text-muted">Tailnet</span>}
        </span>
        <Status line={hostLine(host, sessions, appVersion)} />
        {command && (
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-raised px-1.5 py-0.5 font-mono ui-text-11" title={command}>
              {command}
            </code>
            <IconButton title="Copy command" onClick={() => void navigator.clipboard.writeText(command)}>
              <Copy size={12} />
            </IconButton>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** A host on the tailnet (a pasted link, or a name and a code), or an SSH alias. */
function AddHostDialog({ name: initialName, onClose }: { name: string; onClose: () => void }) {
  const [ssh, setSsh] = useState(false);
  const [text, setText] = useState("");
  const [name, setName] = useState(initialName);
  const [alias, setAlias] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ssh) void hostsApi.sshHosts().then(setSuggestions);
  }, [ssh]);
  const input = readAddHostInput(text);
  const ready = addHostReady(ssh ? { ssh, alias } : { text, name });
  const added = (info: HostInfo) => {
    useStore.setState((s) => ({ hosts: { ...s.hosts, [info.id]: info } }));
    onClose();
  };
  const submit = async () => {
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (ssh) added(await hostsApi.add(alias.trim()));
      else if (input.kind === "link") added(await hostsApi.pair(input.name, input.addrs, input.code));
      else if (input.kind === "code") added(await hostsApi.pair(name.trim(), null, input.code));
    } catch (e) {
      setError((e as { message?: string }).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={ssh ? "Add an SSH host" : "Add host"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="mr-auto ui-text-12.5 text-accent-2 hover:text-accent" onClick={() => (setSsh(!ssh), setError(null))}>
            {ssh ? "Add a host on your tailnet" : "Add an SSH host"}
          </button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? (ssh ? "Adding…" : "Pairing…") : "Add"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {ssh ? (
          <Field label="Host from ~/.ssh/config" hint="moonlet connects with your own OpenSSH config, keys and agent.">
            <input className={inputCls} list="moonlet-ssh-hosts" value={alias} autoFocus onChange={(e) => setAlias(e.target.value)} placeholder="devbox" />
            <datalist id="moonlet-ssh-hosts">
              {suggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
        ) : (
          <>
            <Field
              label="Pairing link or code"
              hint={input.kind === "invalid" ? <span className="text-error">{input.message}</span> : "On the other machine: Settings › Machines › Hosts › Let another Mac connect, or run moonletd pair."}
            >
              <input className={cx(inputCls, "font-mono")} value={text} autoFocus onChange={(e) => setText(e.target.value)} placeholder="7KQ2M-X9PDA" />
            </Field>
            {input.kind === "code" && (
              <Field label="Name on your tailnet">
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="studio-mini" />
              </Field>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="ui-text-12.5 text-error">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Follows pairing on this Mac's daemon: the code shown, and how it ended. */
function usePairing() {
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const unlisten = onDaemonEvent((e) => {
      if (e.host !== HOST) return;
      if (e.name === EV.mobilePaired) {
        setPairing(null);
        setNote(`Paired with ${(e.data as { device: { name: string } }).device.name}`);
      } else if (e.name === EV.mobilePairEnded) {
        setPairing(null);
        setNote(pairEndedText((e.data as { reason: string }).reason));
      }
    });
    return () => void unlisten.then((f) => f());
  }, []);
  // The countdown, and "last seen" lines, tick while the page is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // A code shown here is cancelled when the page is left.
  useEffect(() => {
    if (!pairing) return;
    return () => void rpc(HOST, M.mobilePairCancel).catch(() => {});
  }, [pairing]);
  const start = async () => {
    setNote(null);
    try {
      setPairing(await rpc<MobilePairing>(HOST, M.mobilePairStart));
    } catch (e) {
      errorToast(e);
    }
  };
  return { pairing, note, now, start, cancel: () => setPairing(null) };
}

/** Turns tailnet access on or off; the new state arrives as `mobile.changed`. */
async function setTailnetAccess(enabled: boolean) {
  try {
    // The reply can come after the event that says the listener is up, so
    // it would show stale state.
    await rpc<MobileStatus>(HOST, M.mobileSetEnabled, { enabled });
  } catch (e) {
    errorToast(e);
  }
}

async function removeDevice(id: string, name: string) {
  const ok = await askConfirm({ title: `Remove ${name}?`, message: "It will need to be paired again.", action: "Remove" });
  if (!ok) return;
  try {
    await rpc(HOST, M.mobileRevoke, { id });
  } catch (e) {
    errorToast(e);
  }
}

/** Turning access off also hides a code on screen at once; the daemon says
 * `mobile.pair_ended` too. */
function TailnetSwitch({ status, setting, onOff }: { status: MobileStatus | null; setting: string; onOff: () => void }) {
  return (
    <SwitchRow
      setting={setting}
      label="Allow connections from my tailnet"
      hint={status && <Status line={phoneAccessLine(status)} />}
      on={!!status?.enabled}
      disabled={!status}
      onChange={(on) => {
        if (!on) onOff();
        void setTailnetAccess(on);
      }}
    />
  );
}

/** The code another Mac types, or the link it pastes. */
function MacPairing({ pairing, host, now, onCancel }: { pairing: MobilePairing; host: string; now: number; onCancel: () => void }) {
  const shown = displayCode(pairing.code);
  return (
    <div role="group" aria-label="Pairing" className="flex flex-col gap-2 px-4 py-3.5 ui-text-12.5">
      <span>On the other Mac, open Settings › Machines › Hosts › Add host, and enter this code with this Mac's name, {host}:</span>
      <code data-pair-code className="self-start rounded-md bg-raised px-3 py-1.5 font-mono ui-text-18 tracking-widest">
        {shown}
      </code>
      <span className="text-muted">Or paste the link there:</span>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded bg-raised px-1.5 py-0.5 font-mono ui-text-11" title={pairing.url}>
          {pairing.url}
        </code>
        <IconButton title="Copy link" onClick={() => void navigator.clipboard.writeText(pairing.url)}>
          <Copy size={12} />
        </IconButton>
      </div>
      <span className="ui-text-12 text-muted">{countdown(pairing.expires_at, now)}</span>
      <Button size="sm" variant="ghost" className="self-start" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** This Mac's link to its central host (X41); follows `link.changed`, which
 * every change sends, so replies to changes are not used: one could arrive
 * after a newer state. */
function useLink(): LinkInfo | null {
  const [link, setLink] = useState<LinkInfo | null>(null);
  useEffect(
    () =>
      watchLink({
        get: () => rpc<LinkInfo>(HOST, M.linkGet),
        onChanged: (cb) => {
          const off = onDaemonEvent((e) => {
            if (e.host === HOST && e.name === EV.linkChanged) cb(e.data as LinkInfo);
          });
          return () => void off.then((f) => f());
        },
        onReconnected: (cb) => {
          const off = onHostStatus((h) => {
            if (h.id === HOST && h.status === "connected") cb();
          });
          return () => void off.then((f) => f());
        },
        set: setLink,
      }),
    [],
  );
  return link;
}

/** "Use this Mac for heavy commands" and the link's state (X41). */
function HeavyCommandsRow({ link }: { link: LinkInfo | null }) {
  const id = useId();
  const set = (enabled: boolean) => rpc(HOST, M.linkSet, { worker: { enabled } }).catch(errorToast);
  return (
    <Row
      setting="heavy-commands"
      label="Use this Mac for heavy commands"
      labelId={id}
      hint={
        <>
          {link && <Status line={linkLine(link)} />}
          <span className="mt-0.5 block">For now this only links this Mac to its central host. Commands are not routed here yet.</span>
        </>
      }
    >
      {link && linkRetries(link) && (
        <Button size="sm" variant="ghost" onClick={() => void rpc(HOST, M.linkRetry).catch(errorToast)}>
          Retry
        </Button>
      )}
      <Switch on={!!link?.worker.enabled} disabled={!link} labelledBy={id} onChange={(on) => void set(on)} />
    </Row>
  );
}

/** A tailnet host's Central host choice (X41): pressed on the central host. */
function CentralHostButton({ host, central, onPick }: { host: string; central: string | null; onPick: (next: string | null) => void }) {
  const on = central === host;
  return (
    <Button
      size="sm"
      variant={on ? "subtle" : "ghost"}
      aria-pressed={on}
      title={on ? `${host} is this Mac's central host. Click to clear it.` : `Make ${host} this Mac's central host`}
      onClick={() => onPick(pickCentral(central, host))}
    >
      {on && <Check size={12} />} Central host
    </Button>
  );
}

export function HostsPage({ status }: { status: MobileStatus | null }) {
  const hosts = useStore((s) => s.hosts);
  const sessions = useStore((s) => s.sessions);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string } | null>(null);
  const { pairing, note, now, start, cancel } = usePairing();
  const link = useLink();
  const central = centralHostId(Object.values(hosts), link);
  const pickCentralHost = (next: string | null) => void hostsApi.setCentral(next).catch(errorToast);
  const open = (h: string) => (sessions[h] ?? []).filter((s) => !s.archived).length;
  const local = hosts.local;
  const remotes = Object.values(hosts).filter((h) => h.remote);
  const macs = status ? devicesOfKind(status, "desktop") : [];
  const canPair = !!status?.enabled && status.listening.length > 0;
  const install = async (id: string) => {
    const ok = await askConfirm({
      title: "Install remote helper",
      message: `Install the moonlet helper on ${id}?\n\nThe version-pinned moonletd binary (and the moonlet CLI) are copied to ~/.moonlet/bin over your SSH connection and verified by SHA-256. If the host has a ~/.jaunt folder from jaunt, it is moved to ~/.moonlet and ~/.jaunt becomes a link to it. Nothing else on the host is changed.`,
      action: "Install",
    });
    if (!ok) return;
    setBusy(id);
    try {
      const r = await hostsApi.install(id);
      toast(`Installed moonletd ${r.version} (${r.triple}) on ${id}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };
  const forget = async (id: string) => {
    await hostsApi.remove(id);
    useStore.setState((s) => {
      const hs = { ...s.hosts };
      delete hs[id];
      return { hosts: hs };
    });
  };
  const remove = async (h: HostInfo) => {
    // A connected tailnet host forgets this Mac too; one we cannot reach does not.
    const ask = removeAsks(h);
    if (ask && !(await askConfirm({ ...ask, action: "Remove" }))) return;
    await forget(h.id).catch(errorToast);
  };
  // The host no longer takes this Mac's token: forget it and pair afresh.
  const pairAgain = (id: string) => void forget(id).then(() => setAdding({ name: id }), errorToast);
  return (
    <>
      <PageHeading title="Hosts">Machines that run moonletd. Add a host on your tailnet with a pairing code, or one from your SSH config. Sessions keep running there when the connection drops.</PageHeading>
      {local && (
        <Section title="This Mac">
          <Card>
            <HostRow host={local} sessions={open("local")}>
              <button type="button" className="ui-text-12.5 text-accent-2 hover:text-accent" onClick={() => useStore.setState({ settingsPage: { page: "general" } })}>
                Background daemon
              </button>
            </HostRow>
            <TailnetSwitch status={status} setting="tailnet" onOff={cancel} />
            <HeavyCommandsRow link={link} />
            <div className="flex items-center gap-3 px-4 py-3">
              <Button size="sm" variant="primary" disabled={!canPair || !!pairing} onClick={() => void start()}>
                <Laptop size={13} /> Let another Mac connect
              </Button>
              {note && <span className="ui-text-12 text-muted">{note}</span>}
            </div>
            {pairing && <MacPairing pairing={pairing} host={pairing.host} now={now} onCancel={cancel} />}
          </Card>
        </Section>
      )}
      {macs.length > 0 && (
        <Section title="Macs that can connect">
          <Card>
            {macs.map((d) => (
              <div key={d.id} className="flex items-center gap-3.5 px-4 py-3">
                <span aria-hidden="true" className={cx(iconBox, d.connected && "text-done")}>
                  <Laptop size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate ui-text-13">{d.name}</span>
                  <span className="ui-text-12 text-muted">{deviceLine(d, now)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void removeDevice(d.id, d.name)}>
                  Remove
                </Button>
              </div>
            ))}
          </Card>
        </Section>
      )}
      <Section title="Remote hosts">
        <Card>
          {remotes.map((h) => (
            <HostRow key={h.id} host={h} sessions={open(h.id)}>
              {h.kind === "tailnet" && <CentralHostButton host={h.id} central={central} onPick={pickCentralHost} />}
              {hostActions(h).map((a) =>
                a === "install" || a === "reinstall" ? (
                  <Button key={a} size="sm" variant={a === "reinstall" ? "ghost" : "primary"} disabled={busy === h.id} onClick={() => void install(h.id)}>
                    {busy === h.id ? "Installing…" : a === "reinstall" ? "Reinstall helper" : "Install helper"}
                  </Button>
                ) : a === "pair-again" ? (
                  <Button key={a} size="sm" variant="primary" onClick={() => pairAgain(h.id)}>
                    Pair again
                  </Button>
                ) : (
                  <Button key={a} size="sm" variant="ghost" onClick={() => void hostsApi.reconnect(h.id).catch(errorToast)}>
                    Retry
                  </Button>
                ),
              )}
              <IconButton title={`Remove ${h.id}`} onClick={() => void remove(h)}>
                <Trash2 size={13} />
              </IconButton>
            </HostRow>
          ))}
          <div className="flex px-4 py-3">
            <Button onClick={() => setAdding({ name: "" })}>
              <Plus size={13} /> Add host
            </Button>
          </div>
        </Card>
        <span className="px-0.5 ui-text-12 text-muted">
          A host on your tailnet runs moonlet already: moonlet.app on a Mac, or the install script on Linux. For an SSH host, installing copies the version-pinned moonletd and moonlet CLI to{" "}
          <span className="font-mono">~/.moonlet/bin</span> over SSH and checks their SHA-256.
        </span>
      </Section>
      {adding && <AddHostDialog name={adding.name} onClose={() => setAdding(null)} />}
    </>
  );
}

/** Phones pair with the daemon on this Mac only. */
const HOST = "local";

function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { border: 2 });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={176} height={176} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code" className="shrink-0 rounded bg-white">
      {data.flatMap((row, y) => row.map((dark, x) => (dark ? <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null)))}
    </svg>
  );
}

/** The paired phones, for the nav's count; follows `mobile.changed`. */
export function useMobileStatus(): MobileStatus | null {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  useEffect(() => {
    void rpc<MobileStatus>(HOST, M.mobileStatus).then(setStatus).catch(() => setStatus(null));
    const unlisten = onDaemonEvent((e) => {
      if (e.host === HOST && e.name === EV.mobileChanged) setStatus(e.data as MobileStatus);
    });
    return () => void unlisten.then((f) => f());
  }, []);
  return status;
}

export function PhonesPage({ status }: { status: MobileStatus | null }) {
  const { pairing, note, now, start, cancel } = usePairing();
  const phones = status ? devicesOfKind(status, "phone") : [];
  const canPair = !!status?.enabled && status.listening.length > 0;
  return (
    <>
      <PageHeading title="Phones">The moonlet phone app reaches this Mac over Tailscale: answer agents, review changes and watch checks away from the desk.</PageHeading>
      <Section title="Access">
        <Card>
          <TailnetSwitch status={status} setting="phones" onOff={cancel} />
          <div className="flex items-center gap-3 px-4 py-3">
            <Button size="sm" variant="primary" disabled={!canPair || !!pairing} onClick={() => void start()}>
              <Smartphone size={13} /> Pair a phone
            </Button>
            {note && <span className="ui-text-12 text-muted">{note}</span>}
          </div>
          {pairing && (
            <div role="group" className="flex gap-4 px-4 py-3.5" aria-label="Pairing">
              <QrCode text={pairing.url} />
              <div className="flex min-w-0 flex-1 flex-col gap-2 ui-text-12.5">
                <span>In the moonlet app on your phone, tap Pair a Mac and scan this code.</span>
                <span className="text-muted">Or copy the link and open it on the phone:</span>
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate rounded bg-raised px-1.5 py-0.5 font-mono ui-text-11" title={pairing.url}>
                    {pairing.url}
                  </code>
                  <IconButton title="Copy link" onClick={() => void navigator.clipboard.writeText(pairing.url)}>
                    <Copy size={12} />
                  </IconButton>
                </div>
                <span className="ui-text-12 text-muted">{countdown(pairing.expires_at, now)}</span>
                <Button size="sm" variant="ghost" className="self-start" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Section>
      {phones.length > 0 && (
        <Section title="Paired phones">
          <Card>
            {phones.map((d) => (
              <div key={d.id} className="flex items-center gap-3.5 px-4 py-3">
                <span aria-hidden="true" className={cx(iconBox, d.connected && "text-done")}>
                  <Smartphone size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate ui-text-13">{d.name}</span>
                  <span className="ui-text-12 text-muted">{deviceLine(d, now)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void removeDevice(d.id, d.name)}>
                  Remove
                </Button>
              </div>
            ))}
          </Card>
        </Section>
      )}
    </>
  );
}
