// Hosts (X40): the paired Macs and the SSH hosts reached through them, pairing
// another Mac, and the phone's notification and Face ID settings.

import { useEffect, useState } from "react";
import { Laptop, QrCode, RotateCw, Server } from "lucide-react";
import { type NotifyKey, forgetMac, reconnect, showScreen, updateSettings, useApp } from "../lib/app";
import { hostMeta, hostRoute, hostWord } from "../lib/hosts";
import { HOST_COLOR } from "../lib/palette";
import { Btn, StateGlyph, Switch, Title, cx } from "../components/ui";


const TOGGLES: { key: NotifyKey; label: string; state: "blocked" | "done" | "error" | "idle" }[] = [
  { key: "blocked", label: "An agent needs input", state: "blocked" },
  { key: "done", label: "An agent finishes", state: "done" },
  { key: "error", label: "An agent fails", state: "error" },
  { key: "checks", label: "PR checks fail", state: "idle" },
];

export function HostsScreen() {
  const hosts = useApp((s) => s.hosts);
  const seen = useApp((s) => s.seen);
  const data = useApp((s) => s.data);
  const settings = useApp((s) => s.settings);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const list = Object.values(hosts).sort((a, b) => (a.mac === b.mac ? Number(!!a.via) - Number(!!b.via) : a.mac.localeCompare(b.mac)));

  return (
    <div className="scroll h-full">
      <Title>Hosts</Title>
      <div className="flex flex-col gap-2.5 px-4 pt-4 pb-6">
        {list.map((h) => {
          const word = hostWord(h.status);
          const d = data[h.id];
          const sessions = d?.sessions.filter((s) => !s.archived).length ?? 0;
          const terminals = d ? Object.keys(d.terminals).length : 0;
          return (
            <div key={h.id} className="flex gap-3 rounded-[14px] border border-border bg-panel p-3.5">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-raised text-muted">{h.via ? <Server size={18} /> : <Laptop size={18} />}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-semibold">{h.label}</span>
                  <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: HOST_COLOR[word] }} />
                  <span className="text-[12.5px]" style={{ color: HOST_COLOR[word] }}>
                    {word}
                  </span>
                </div>
                <span className="text-[12.5px] text-muted">{hostRoute({ status: h.status, via: h.via }, seen[h.id] ?? { latencyMs: null, lastSeen: null }, now)}</span>
                {h.message && word === "offline" && <span className="text-[12px] text-faint">{h.message}</span>}
                <span className="font-mono text-[11.5px] text-faint">{hostMeta(h.daemon_version, sessions, terminals)}</span>
                {(word === "offline" || !h.via) && (
                  <div className="mt-1.5 flex gap-2">
                    {word === "offline" && (
                      <Btn className="h-9 rounded-[9px] text-[13.5px]" onClick={() => void reconnect(h.id)}>
                        <RotateCw size={13} /> Reconnect
                      </Btn>
                    )}
                    {!h.via && <ForgetButton id={h.mac} name={h.label} />}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button type="button" onClick={() => showScreen({ kind: "pair" })} className="flex min-h-14 items-center gap-3 rounded-[14px] border border-dashed border-border-strong px-3.5 text-left">
          <QrCode size={20} className="text-muted" />
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[15px] font-medium">Pair a Mac</span>
            <span className="text-[12.5px] text-muted">On the Mac: Settings › Phones › Pair a phone</span>
          </span>
        </button>

        <div className="eyebrow mt-3">Notify me when</div>
        <div className="flex flex-col rounded-[14px] border border-border bg-panel">
          {TOGGLES.map((t) => (
            <Switch
              key={t.key}
              label={t.label}
              on={!settings.notifyOff.includes(t.key)}
              onChange={(on) => updateSettings({ notifyOff: on ? settings.notifyOff.filter((k) => k !== t.key) : [...settings.notifyOff, t.key] })}
            >
              <span className="flex w-2.5 justify-center">
                <StateGlyph state={t.state} />
              </span>
            </Switch>
          ))}
        </div>
        <div className="flex flex-col rounded-[14px] border border-border bg-panel">
          <Switch label="Require Face ID to allow" on={settings.faceId} onChange={(faceId) => updateSettings({ faceId })} />
        </div>
        <span className="text-[12.5px] leading-[1.45] text-faint">Allowing a tool, approving a plan, answering a question or letting an agent read a terminal asks for Face ID first. Notifications arrive once push notifications are set up for this app.</span>
      </div>
    </div>
  );
}

function ForgetButton({ id, name }: { id: string; name: string }) {
  const [sure, setSure] = useState(false);
  return (
    <Btn tone={sure ? "secondary" : "ghost"} className={cx("h-9 rounded-[9px] text-[13.5px]", sure && "text-error")} onClick={() => (sure ? void forgetMac(id) : setSure(true))}>
      {sure ? `Forget ${name}` : "Forget"}
    </Btn>
  );
}
