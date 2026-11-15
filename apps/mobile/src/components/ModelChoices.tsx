import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { modelMenu } from "@desktop/lib/agents";
import type { ClaudeModel } from "@desktop/lib/protocol";
import { cx } from "./ui";

/** Claude's models in a sheet (X105): the newest, and More models opening the rest in place. */
export function ModelChoices({ models, current, onPick }: { models: ClaudeModel[] | undefined; current: string | null | undefined; onPick: (id: string) => void }) {
  const menu = modelMenu(models);
  const [more, setMore] = useState(() => menu.more.some((m) => m.id === current));
  const row = (m: { id: string; label: string }) => (
    <button key={m.id} type="button" onClick={() => onPick(m.id)} className={cx("flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]", m.id === current && "text-accent")}>
      <span className="min-w-0 flex-1 truncate">{m.label}</span>
      {m.id === current && <Check size={16} className="text-accent" />}
    </button>
  );
  return (
    <div className="flex flex-col">
      {menu.latest.map(row)}
      {menu.more.length > 0 && (
        <button type="button" onClick={() => setMore(!more)} className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px] text-muted">
          <span className="flex-1">More models</span>
          <ChevronDown size={16} className={cx("transition-transform", more && "rotate-180")} />
        </button>
      )}
      {more && menu.more.map(row)}
    </div>
  );
}
