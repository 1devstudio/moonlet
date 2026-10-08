import { StatusMark } from "@moonlet/ds";

const all = ["running", "ok", "denied", "error"] as const;

export const AllStatuses = () => (
  <div className="flex flex-col gap-2 bg-bg p-4 text-[12.5px] text-muted">
    {all.map((s) => (
      <span key={s} className="flex items-center gap-2">
        <StatusMark status={s} /> {s}
      </span>
    ))}
  </div>
);
