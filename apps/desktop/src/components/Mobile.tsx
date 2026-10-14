// Settings › Mobile (X39): let phones on the tailnet in, pair one with a QR
// code, and remove paired phones.

import { useEffect, useState } from "react";
import { encode } from "uqr";
import { Copy, Smartphone } from "lucide-react";
import { askConfirm } from "../lib/confirm";
import { onDaemonEvent, rpc } from "../lib/daemon";
import { countdown, deviceLine, mobileLine, pairEndedText } from "../lib/mobile";
import { EV, M, type MobilePairing, type MobileStatus } from "../lib/protocol";
import { errorToast } from "../lib/store";
import { Button, cx } from "./ui";

/** Phones pair with the daemon on this Mac only. */
const HOST = "local";

function QrCode({ text }: { text: string }) {
  const { data, size } = encode(text, { border: 2 });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={176} height={176} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code" className="rounded bg-white">
      {data.flatMap((row, y) => row.map((dark, x) => (dark ? <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill="#000" /> : null)))}
    </svg>
  );
}

export function MobileSection() {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void rpc<MobileStatus>(HOST, M.mobileStatus).then(setStatus).catch(() => setStatus(null));
    const unlisten = onDaemonEvent((e) => {
      if (e.host !== HOST) return;
      if (e.name === EV.mobileChanged) setStatus(e.data as MobileStatus);
      else if (e.name === EV.mobilePaired) {
        setPairing(null);
        setNote(`Paired with ${(e.data as { device: { name: string } }).device.name}`);
      } else if (e.name === EV.mobilePairEnded) {
        setPairing(null);
        setNote(pairEndedText((e.data as { reason: string }).reason));
      }
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // The countdown, and "last seen" lines, tick while the section is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A code shown here is cancelled when the section closes.
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
    <section className="mb-5">
      <h3 className="mb-1 ui-text-12 font-semibold">Mobile</h3>
      <p className="mb-2 ui-text-12 text-muted">The moonlet phone app reaches this Mac over Tailscale: answer agents, review changes and watch checks away from the desk.</p>
      <label className="flex items-center gap-2 ui-text-12.5">
        <input type="checkbox" disabled={!status} checked={!!status?.enabled} onChange={(e) => void setEnabled(e.target.checked)} /> Allow phones on my tailnet
      </label>
      {status && <div className={cx("mt-1 ui-text-12", status.enabled && !status.tailscale ? "text-blocked" : "text-muted")}>{mobileLine(status)}</div>}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={!canPair || !!pairing} onClick={() => void startPairing()}>
          <Smartphone size={13} /> Pair a phone
        </Button>
        {note && <span className="ui-text-12 text-muted">{note}</span>}
      </div>

      {pairing && (
        <div className="mt-3 flex gap-4 rounded-md border border-border p-3" aria-label="Pairing">
          <QrCode text={pairing.url} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 ui-text-12.5">
            <span>In the moonlet app on your phone, tap Pair a Mac and scan this code.</span>
            <span className="text-muted">Or copy the link and open it on the phone:</span>
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-raised px-1.5 py-0.5 font-mono ui-text-11" title={pairing.url}>
                {pairing.url}
              </code>
              <Button size="sm" variant="ghost" title="Copy link" onClick={() => void navigator.clipboard.writeText(pairing.url)}>
                <Copy size={12} />
              </Button>
            </div>
            <span className="ui-text-12 text-muted">{countdown(pairing.expires_at, now)}</span>
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setPairing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!!status?.devices.length && (
        <>
          <h4 className="mt-3 mb-1.5 ui-text-12 font-medium text-muted">Paired phones</h4>
          <ul className="space-y-1.5">
            {status.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 ui-text-12.5">
                <Smartphone size={14} className={d.connected ? "text-done" : "text-muted"} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{d.name}</span>
                  <span className="ui-text-11 text-muted">{deviceLine(d, now)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void remove(d.id, d.name)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
