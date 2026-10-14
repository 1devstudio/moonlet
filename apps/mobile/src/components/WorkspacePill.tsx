// The workspace chip at the top of Inbox and Sessions. Workspaces are matched
// by name across hosts: every daemon has its own "Personal" (X32).

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { colorHex } from "@desktop/lib/workspaces";
import { updateSettings, useApp } from "../lib/app";
import { workspaceChoices } from "../lib/workspaceChoices";
import { Sheet } from "./Sheet";
import { cx } from "./ui";

export function WorkspacePill() {
  const data = useApp((s) => s.data);
  const hosts = useApp((s) => s.hosts);
  const shown = useApp((s) => s.settings.workspace);
  const [open, setOpen] = useState(false);
  const choices = workspaceChoices(Object.keys(hosts).map((h) => data[h]?.workspaces ?? []));
  const current = choices.find((c) => c.name === shown);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-9 items-center gap-[7px] rounded-[18px] border border-border-strong bg-panel px-3 text-[13.5px]">
        <span className="h-2 w-2 rounded-full" style={{ background: current ? colorHex(current.color) : "#8c8c8c" }} />
        {current?.name ?? "All workspaces"}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <Sheet label="Workspace" onClose={() => setOpen(false)}>
          <div className="flex flex-col px-2 pb-2">
            {[{ name: null as string | null, color: null }, ...choices].map((c) => (
              <button
                key={c.name ?? ""}
                type="button"
                onClick={() => {
                  updateSettings({ workspace: c.name });
                  setOpen(false);
                }}
                className="flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-[15px]"
              >
                <span className={cx("h-2.5 w-2.5 rounded-full", !c.color && "border border-muted")} style={c.color ? { background: colorHex(c.color) } : undefined} />
                <span className="flex-1">{c.name ?? "All workspaces"}</span>
                {c.name === shown && <Check size={16} className="text-accent" />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
