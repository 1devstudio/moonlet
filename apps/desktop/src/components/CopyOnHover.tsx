// A value in a header (a branch, a file's path) with copy buttons that show
// while it is hovered: the first copies what it shows, a second its full path.

import type { ReactNode } from "react";
import { Copy, FolderOpen } from "lucide-react";
import type { CopyChoice } from "../lib/copyPaths";
import { errorToast, toast } from "../lib/store";
import { IconButton, cx } from "./ui";

export function CopyOnHover({ copies, className, children }: { copies: CopyChoice[]; className?: string; children: ReactNode }) {
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`), errorToast);
  return (
    <span className={cx("group flex min-w-0 shrink items-center gap-0.5", className)}>
      {children}
      {copies.map((c, i) => (
        <IconButton key={c.label} title={c.label} className="invisible h-5 w-5 shrink-0 group-hover:visible focus-visible:visible" onClick={() => copy(c.text)}>
          {i === 0 ? <Copy size={12} /> : <FolderOpen size={12} />}
        </IconButton>
      ))}
    </span>
  );
}
