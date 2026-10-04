import { IconButton, icons } from "@jaunt/ds";

const { X, MoreHorizontal, Plus, Copy, Trash2 } = icons;

export const Toolbar = () => (
  <div className="flex items-center gap-1 bg-panel p-3">
    <IconButton title="New session"><Plus size={15} /></IconButton>
    <IconButton title="Copy path"><Copy size={14} /></IconButton>
    <IconButton title="Workspace options"><MoreHorizontal size={16} /></IconButton>
    <IconButton title="Delete"><Trash2 size={14} /></IconButton>
    <IconButton title="Close tab"><X size={14} /></IconButton>
  </div>
);

export const Disabled = () => (
  <div className="flex items-center gap-1 bg-panel p-3">
    <IconButton title="New session" disabled><Plus size={15} /></IconButton>
    <IconButton title="Close tab" disabled><X size={14} /></IconButton>
  </div>
);
