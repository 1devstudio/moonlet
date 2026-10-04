import { useEffect, useRef } from "react";
import { IconButton, Menu, icons } from "@jaunt/ds";

const { MoreHorizontal, Archive, FolderPlus } = icons;

/** Opens itself on mount so the card shows the menu panel. */
function OpenTrigger({ open }: { open: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (!done.current) {
      done.current = true;
      open();
    }
  }, [open]);
  return (
    <IconButton title="Workspace options" onClick={open}>
      <MoreHorizontal size={16} />
    </IconButton>
  );
}

export const WorkspaceOptions = () => (
  <div className="bg-panel p-4" style={{ width: 300, height: 320 }}>
    <Menu
      items={[
        { kind: "label", label: "Group by" },
        { label: "Project", checked: true, onSelect: () => {} },
        { label: "Status", onSelect: () => {} },
        { kind: "divider" },
        { label: "Add project…", icon: <FolderPlus size={14} />, onSelect: () => {} },
        { label: "Archive workspace", icon: <Archive size={14} />, danger: true, onSelect: () => {} },
      ]}
      trigger={(open) => <OpenTrigger open={open} />}
    />
  </div>
);
