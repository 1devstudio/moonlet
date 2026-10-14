// Settings › Machines (X43): this Mac and the remote hosts (R1, R2), and the
// phones paired with this Mac (X39).

import { useEffect, useState } from "react";
import { encode } from "uqr";
import { Copy, Server, Smartphone, SquareTerminal, Trash2 } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { hostsApi, onDaemonEvent, rpc } from "../../lib/daemon";
import { countdown, deviceLine, pairEndedText } from "../../lib/mobile";
import { EV, M, type HostInfo, type MobilePairing, type MobileStatus } from "../../lib/protocol";
import { errorToast, toast, useStore } from "../../lib/store";
import { hostLine, phoneAccessLine } from "../../lib/settingsPage";
import { Button, IconButton, cx } from "../ui";
import { Card, PageHeading, Section, Status, SwitchRow, fieldCls } from "./controls";

const iconBox = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted";

function HostRow({ host, sessions, children }: { host: HostInfo; sessions: number; children?: React.ReactNode }) {
  return (
    <div data-setting={`host-${host.id}`} className="flex items-center gap-3.5 px-4 py-3.5">
      <span aria-hidden="true" className={iconBox}>
        {host.remote ? <Server size={16} /> : <SquareTerminal size={16} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="ui-text-13 font-medium">{host.id}</span>
        <Status line={hostLine(host, sessions)} />
      </div>
      {children}
    </div>
  );
}

export function HostsPage() {
  const hosts = useStore((s) => s.hosts);
  const sessions = useStore((s) => s.sessions);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void hostsApi.sshHosts().then(setSuggestions);
  }, []);
  const open = (h: string) => (sessions[h] ?? []).filter((s) => !s.archived).length;
  const local = hosts.local;
  const remotes = Object.values(hosts).filter((h) => h.remote);
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
  const add = async () => {
    try {
      const info = await hostsApi.add(alias.trim());
      useStore.setState((s) => ({ hosts: { ...s.hosts, [info.id]: info } }));
      setAlias("");
    } catch (e) {
      errorToast(e);
    }
  };
  const remove = (id: string) =>
    void hostsApi
      .remove(id)
      .then(() =>
        useStore.setState((s) => {
          const hs = { ...s.hosts };
          delete hs[id];
          return { hosts: hs };
        }),
      )
      .catch(errorToast);
  return (
    <>
      <PageHeading title="Hosts">Machines that run moonletd. Remote hosts use your own OpenSSH config, keys and agent; sessions keep running there when the connection drops.</PageHeading>
      {local && (
        <Section title="This Mac">
          <Card>
            <HostRow host={local} sessions={open("local")}>
              <button type="button" className="ui-text-12.5 text-accent-2 hover:text-accent" onClick={() => useStore.setState({ settingsPage: { page: "general" } })}>
                Background daemon
              </button>
            </HostRow>
          </Card>
        </Section>
      )}
      <Section title="Remote hosts">
        <Card>
          {remotes.map((h) => (
            <HostRow key={h.id} host={h} sessions={open(h.id)}>
              {(h.status === "needs_install" || h.status === "connected") && (
                <Button size="sm" variant={h.status === "connected" ? "ghost" : "primary"} disabled={busy === h.id} onClick={() => void install(h.id)}>
                  {busy === h.id ? "Installing…" : h.status === "connected" ? "Reinstall helper" : "Install helper"}
                </Button>
              )}
              <IconButton title={`Remove ${h.id}`} onClick={() => remove(h.id)}>
                <Trash2 size={13} />
              </IconButton>
            </HostRow>
          ))}
          <form
            className="flex gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (alias.trim()) void add();
            }}
          >
            <input className={cx(fieldCls, "flex-1")} list="moonlet-ssh-hosts" aria-label="Host from ~/.ssh/config" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Host from ~/.ssh/config" />
            <datalist id="moonlet-ssh-hosts">
              {suggestions.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            <Button type="submit" disabled={!alias.trim()}>
              Add host
            </Button>
          </form>
        </Card>
        <span className="px-0.5 ui-text-12 text-muted">
          Installing copies the version-pinned moonletd and moonlet CLI to <span className="font-mono">~/.moonlet/bin</span> over SSH and checks their SHA-256. Nothing else on the host changes.
        </span>
      </Section>
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

  const setEnabled = async (enabled: boolean) => {
    try {
      // The new state arrives as `mobile.changed`. The reply can come after
      // the event that says the listener is up, so it would show stale state.
      await rpc<MobileStatus>(HOST, M.mobileSetEnabled, { enabled });
      if (!enabled) setPairing(null);
    } catch (e) {
      errorToast(e);
    }
  };

  const startPairing = async () => {
    setNote(null);
    try {
      setPairing(await rpc<MobilePairing>(HOST, M.mobilePairStart));
    } catch (e) {
      errorToast(e);
    }
  };

  const remove = async (id: string, name: string) => {
    const ok = await askConfirm({ title: `Remove ${name}?`, message: "It will need to be paired again.", action: "Remove" });
    if (!ok) return;
    try {
      await rpc(HOST, M.mobileRevoke, { id });
    } catch (e) {
      errorToast(e);
    }
  };

  const canPair = !!status?.enabled && status.listening.length > 0;
  return (
    <>
      <PageHeading title="Phones">The moonlet phone app reaches this Mac over Tailscale: answer agents, review changes and watch checks away from the desk.</PageHeading>
      <Section title="Access">
        <Card>
          <SwitchRow
            setting="phones"
            label="Allow phones on my tailnet"
            hint={status && <Status line={phoneAccessLine(status)} />}
            on={!!status?.enabled}
            disabled={!status}
            onChange={(on) => void setEnabled(on)}
          />
          <div className="flex items-center gap-3 px-4 py-3">
            <Button size="sm" variant="primary" disabled={!canPair || !!pairing} onClick={() => void startPairing()}>
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
                <Button size="sm" variant="ghost" className="self-start" onClick={() => setPairing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Section>
      {!!status?.devices.length && (
        <Section title="Paired phones">
          <Card>
            {status.devices.map((d) => (
              <div key={d.id} className="flex items-center gap-3.5 px-4 py-3">
                <span aria-hidden="true" className={cx(iconBox, d.connected && "text-done")}>
                  <Smartphone size={16} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate ui-text-13">{d.name}</span>
                  <span className="ui-text-12 text-muted">{deviceLine(d, now)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void remove(d.id, d.name)}>
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
