import { ClipboardList } from "lucide-react";
import { type PlanView, planLabels } from "../lib/plan";
import { Markdown, PLAN_TONE_BG, PLAN_TONE_TEXT } from "./AgentView";
import { Empty, cx } from "./ui";

/** The Plan tab (X24): the latest plan of the session's chat, with its status. */
export function PlanPanel({ view }: { view: PlanView | null }) {
  if (!view) {
    return (
      <Empty icon={<ClipboardList size={20} />} title="No plan yet">
        Plans Claude proposes in Plan mode show here.
      </Empty>
    );
  }
  const l = planLabels(view.status, view.mode);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-5 pb-3 pt-3.5">
        <div className={cx("flex items-center gap-2 ui-text-12", PLAN_TONE_TEXT[l.tone])}>
          <span className={cx("h-1.5 w-1.5 rounded-full", PLAN_TONE_BG[l.tone])} />
          <span>{l.panel}</span>
          {view.ts && (
            <span className="ml-auto text-faint">
              Updated {new Date(view.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ")}
            </span>
          )}
        </div>
        {view.file && (
          <div className="selectable truncate font-mono ui-text-11.5 text-faint" title={view.file}>
            {view.file}
          </div>
        )}
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto px-5 pb-6 pt-4 leading-[1.6]">
        <Markdown text={view.plan} />
      </div>
    </div>
  );
}
