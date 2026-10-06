import { useState } from "react";
import { ChevronDown, FilePen, ListTodo, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { askConfirm } from "../lib/confirm";
import { BYPASS_MODE, CLAUDE_MODES, resolveMode } from "../lib/agents";
import { Menu, type MenuItem } from "./Menu";
import { cx } from "./ui";

const ICONS = { auto: Zap, manual: ShieldCheck, acceptEdits: FilePen, plan: ListTodo, bypassPermissions: ShieldAlert };

/**
 * State of a Claude permission mode picker (X7), shared by the agent footer and
 * the new-session modal. Bypass permissions stays behind an explicit confirm for
 * as long as the picker lives.
 */
export function useModeMenu(mode: string, onPick: (mode: string) => void) {
  const [bypassOk, setBypassOk] = useState(false);
  const bypassOn = bypassOk || mode === BYPASS_MODE.id;
  const enableBypass = async () => {
    const ok = await askConfirm({
      title: "Bypass permissions",
      message: "Bypass permissions lets Claude run commands and edit files without asking. Turn it on for this session?",
      action: "Turn on",
      variant: "danger",
    });
    if (!ok) return;
    setBypassOk(true);
    onPick(BYPASS_MODE.id);
  };
  const items: MenuItem[] = [
    { kind: "label", label: "Mode" },
    ...CLAUDE_MODES.map((m, i) => ({ label: m.label, description: m.description, hint: String(i + 1), checked: mode === m.id, onSelect: () => onPick(m.id) })),
    bypassOn
      ? { label: BYPASS_MODE.label, description: BYPASS_MODE.description, checked: mode === BYPASS_MODE.id, onSelect: () => onPick(BYPASS_MODE.id) }
      : { label: BYPASS_MODE.label, hint: "Enable", onSelect: () => void enableBypass() },
  ];
  const info = mode === BYPASS_MODE.id ? BYPASS_MODE : CLAUDE_MODES.find((m) => m.id === resolveMode(mode))!;
  return { mode, items, info, bypassOn, pick: onPick };
}

/** The mode chip and its dropdown. `className` sizes the chip for its surroundings. */
export function ModeMenu({ menu, className, iconSize, align = "right" }: { menu: ReturnType<typeof useModeMenu>; className: string; iconSize: number; align?: "left" | "right" }) {
  const Icon = ICONS[menu.info.id as keyof typeof ICONS];
  return (
    <Menu
      side="top"
      align={align}
      width={300}
      items={menu.items}
      trigger={(open) => (
        <button title="Permission mode" className={cx("flex items-center gap-1.5 rounded-md hover:bg-hover hover:text-fg", className, menu.mode === BYPASS_MODE.id && "text-blocked")} onClick={open}>
          <Icon size={iconSize} />
          <span>{menu.info.label}</span>
          <ChevronDown size={iconSize} />
        </button>
      )}
    />
  );
}
