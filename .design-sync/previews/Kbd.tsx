import { Kbd } from "@moonlet/ds";

export const Shortcuts = () => (
  <div className="flex flex-col gap-2 bg-bg p-4 text-[13px] text-muted" style={{ width: 260 }}>
    <span className="flex items-center justify-between gap-6">New session <Kbd>⇧⌘N</Kbd></span>
    <span className="flex items-center justify-between gap-6">Command palette <Kbd>⌘K</Kbd></span>
    <span className="flex items-center justify-between gap-6">Stop agent <Kbd>⌘.</Kbd></span>
  </div>
);
