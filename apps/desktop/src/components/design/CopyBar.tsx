// A copy of another member's design system or design (X71): what it is,
// and Move here.

import { Lock } from "lucide-react";
import { copyNotice, ownerWorking, type Owned } from "../../lib/designCopies";
import { moveHere } from "../../lib/designStore";
import { errorToast } from "../../lib/store";
import { Button } from "../ui";

export function CopyBar({ host, workspace, kind, item }: { host: string; workspace: string; kind: "system" | "design"; item: { slug: string; name: string } & Owned }) {
  const notice = copyNotice(item);
  if (!notice) return null;
  const working = ownerWorking(item, kind);
  return (
    <div role="status" aria-label="Copy" className="flex shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-5 py-2 ui-text-12.5 text-muted">
      <Lock size={12} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate">
        {notice}
        {working && <span className="ml-2 text-working">{working}</span>}
      </span>
      <Button size="sm" onClick={() => void moveHere(host, workspace, kind, item).catch(errorToast)}>
        Move here
      </Button>
    </div>
  );
}
