// Pair with a Mac (X39, X40): scan the QR code from Settings › Mobile on the
// Mac, or paste its link.

import { useEffect, useState } from "react";
import { Check, ChevronLeft, ScanLine } from "lucide-react";
import { pairMac, showScreen, showTab } from "../lib/app";
import { deviceName, onPhone, scanQr, tap } from "../lib/native";
import { parsePairLink } from "../lib/pairLink";
import { Btn, Moon } from "../components/ui";

/** "Paired with studio-mac", then on to the Inbox. */
export function PairedScreen({ name }: { name: string }) {
  useEffect(() => {
    const t = setTimeout(() => showTab("inbox"), 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(62,207,110,0.14)] text-done">
        <Check size={28} />
      </span>
      <h1 className="m-0 text-[24px] font-semibold">Paired with {name}</h1>
      <Btn tone="primary" className="w-full max-w-xs" onClick={() => showTab("inbox")}>
        Continue
      </Btn>
    </div>
  );
}

export function PairScreen({ first }: { first: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async (raw: string) => {
    const link = parsePairLink(raw);
    if (!link) {
      setError("That is not a moonlet pairing link. On the Mac, open Settings › Mobile › Pair a phone.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const mac = await pairMac(link, deviceName());
      void tap("success");
      showScreen({ kind: "paired", name: mac.label });
    } catch (e) {
      setError(e && typeof e === "object" && "message" in e ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    const content = await scanQr();
    if (content) await pair(content);
  };

  return (
    <div className="scroll flex h-full flex-col gap-5 px-5" style={{ paddingTop: "calc(var(--safe-top) + 14px)" }}>
      {!first && (
        <button type="button" aria-label="Back" onClick={() => showScreen(null)} className="-ml-2 flex h-10 w-10 items-center justify-center text-muted">
          <ChevronLeft size={24} />
        </button>
      )}
      <div className="mt-6 flex flex-col items-center gap-3 text-center">
        <Moon size={72} />
        <h1 className="m-0 text-[26px] font-semibold">{first ? "Pair with your Mac" : "Pair a Mac"}</h1>
        <p className="m-0 text-[14px] leading-snug text-muted">On the Mac: Settings › Mobile › Pair a phone. Your phone and the Mac must be on the same tailnet.</p>
      </div>
      {onPhone && (
        <Btn tone="primary" disabled={busy} onClick={() => void scan()}>
          <ScanLine size={17} /> Scan QR code
        </Btn>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor="link" className="text-[13px] text-muted">
          {onPhone ? "Or paste the link" : "Paste the link"}
        </label>
        <textarea
          id="link"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="moonlet://pair?v=1&host=…"
          className="rounded-[10px] border border-border-strong bg-panel p-3 font-mono text-[12.5px] outline-none"
        />
        <Btn tone={onPhone ? "secondary" : "primary"} disabled={busy || !text.trim()} onClick={() => void pair(text)}>
          {busy ? "Pairing…" : "Pair"}
        </Btn>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] leading-snug text-error">
          {error}
        </p>
      )}
    </div>
  );
}
