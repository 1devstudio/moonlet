import { StateGlyph } from "@moonlet/ds";

const states = [
  ["working", "Working"],
  ["blocked", "Needs input"],
  ["done", "Ready for review"],
  ["error", "Failed"],
  ["idle", "Idle"],
] as const;

export const AllStates = () => (
  <div className="flex flex-col gap-2 bg-panel p-4 text-[13px] text-fg">
    {states.map(([s, label]) => (
      <span key={s} className="flex items-center gap-2.5">
        <StateGlyph state={s} />
        {label}
      </span>
    ))}
  </div>
);

