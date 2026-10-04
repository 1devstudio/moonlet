import { DiffStat } from "@jaunt/ds";

export const Examples = () => (
  <div className="flex flex-col gap-2 bg-panel p-4 text-[13px]">
    <DiffStat add={48} del={12} />
    <DiffStat add={394} del={120} />
    <DiffStat add={0} del={7} />
  </div>
);
