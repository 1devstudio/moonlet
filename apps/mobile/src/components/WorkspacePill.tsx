// The workspace chip at the top of Inbox and Sessions. A workspace the
// members of one account share shows once, as in the desktop's switcher (X68).

import { Fragment, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { colorHex } from "@desktop/lib/workspaces";
import { updateSettings, useApp, useShownWorkspace } from "../lib/app";
import { hostWorkspaces, workspaceChoices } from "../lib/workspaceChoices";
import { Sheet } from "./Sheet";
import { cx } from "./ui";

export function WorkspacePill() {
  const data = useApp((s) => s.data);
  const hosts = useApp((s) => s.hosts);
  const shown = useShownWorkspace();
  const [open, setOpen] = useState(false);
  const choices = workspaceChoices(hostWorkspaces(hosts, data));
  const isCurrent = (ref: { id: string; account: string } | null) => (ref === null ? shown === null : shown?.id === ref.id && shown.account === ref.account);
  const current = choices.find((c) => isCurrent(c.ref));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-9 items-center gap-[7px] rounded-[18px] border border-border-strong bg-panel px-3 text-[13.5px]">
        <span className="h-2 w-2 rounded-full" style={{ background: current ? colorHex(current.color) : "var(--color-muted)" }} />
        {current?.name ?? "All workspaces"}
        {/* Two of one name in one account (X68): which one is chosen. */}
        {current?.from && <span className="max-w-[96px] truncate text-[12px] text-faint">from {current.from}</span>}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <Sheet label="Workspace" onClose={() => setOpen(false)}>
          <div className="flex flex-col px-2 pb-2">
            {[{ ref: null, name: "All workspaces", color: null, from: null, hostLabel: null }, ...choices].map((c) => (
              <Fragment key={c.ref ? `${c.ref.account}/${c.ref.id}` : ""}>
                {c.hostLabel && <div className="eyebrow px-3 pt-3 pb-1">{c.hostLabel}</div>}
                <button
                  type="button"
                  onClick={() => {
                    updateSettings({ workspace: c.ref });
                    setOpen(false);
                  }}
                  className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]"
                >
                  <span className={cx("h-2.5 w-2.5 rounded-full", !c.color && "border border-muted")} style={c.color ? { background: colorHex(c.color) } : undefined} />
                  <span className="flex-1">
                    {c.name}
                    {c.from && <span className="ml-2 text-[12.5px] text-faint">from {c.from}</span>}
                  </span>
                  {isCurrent(c.ref) && <Check size={16} className="text-accent" />}
                </button>
              </Fragment>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
