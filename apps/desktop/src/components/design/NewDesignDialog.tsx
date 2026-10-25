// New design (X65 journey A step 2): a name, a design system and a brief;
// Create design (⌘↵) starts the design's agent with the brief and opens it.

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorToast, toast, useStore } from "../../lib/store";
import { newDesignReady, systemSummary } from "../../lib/design";
import { createDesign, showDesign, systemsOf, useDesign } from "../../lib/designStore";
import { workspaceProjects } from "../../lib/tasksStore";
import { useNow } from "../../lib/useNow";
import { wsKey } from "../../lib/workspaces";
import { cx } from "../../lib/cx";
import { AgentIcon, Button, Dialog, Field, Kbd, inputCls, selectCls } from "../ui";

/** New design (X65 journey A step 2): a name, a design system and a brief;
 *  Create design (⌘↵) starts its agent with the brief and opens it. */
export function NewDesignDialog({ host, workspace }: { host: string; workspace: string }) {
  const systems = useDesign((d) => systemsOf(d, host, workspace)) ?? [];
  const shownSlug = useDesign((d) => d.shown[wsKey(host, workspace)]);
  const projectList = useStore(useShallow((s) => workspaceProjects(s, host, workspace)));
  const projects = useMemo(() => projectList.map((p) => ({ path: p.path, name: p.name })), [projectList]);
  const [name, setName] = useState("");
  const [system, setSystem] = useState(() => systems.find((s) => s.slug === shownSlug)?.slug ?? systems[0]?.slug ?? "");
  const [brief, setBrief] = useState("");
  const [creating, setCreating] = useState(false);
  const now = useNow(true);
  const close = () => useStore.setState({ dialog: null });
  const picked = systems.find((s) => s.slug === system);
  const check = newDesignReady({ name, system, brief }, systems.map((s) => s.slug));
  const ready = check.ready && !creating;
  const create = async () => {
    if (!ready) return;
    setCreating(true);
    try {
      const made = await createDesign(host, workspace, { name: name.trim(), system, brief: brief.trim() });
      showDesign(host, workspace, made.slug);
      close();
      if (made.agent_error) toast(`${made.name} was made, but its agent did not start: ${made.agent_error}`, "error");
    } catch (e) {
      errorToast(e);
      setCreating(false);
    }
  };
  return (
    <Dialog
      title="New design"
      width={560}
      onClose={close}
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 self-center ui-text-12 text-faint">
            <AgentIcon agent="claude" size={12} /> Claude Code · Accept edits in the design's folder
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} title={check.why ?? undefined} onClick={() => void create()}>
            Create design <Kbd>⌘↵</Kbd>
          </Button>
        </>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            void create();
          }
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input autoFocus className={inputCls} value={name} placeholder="Settings page" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Design system">
            <select aria-label="Design system" className={selectCls} value={system} onChange={(e) => setSystem(e.target.value)}>
              {systems.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="-mt-1.5 mb-3 ui-text-12 text-faint">{picked ? systemSummary(picked, projects, now) : "A design starts from a design system. Build one first."}</p>
        <Field label="Brief" hint="Claude's first message. It also gets the design system's README.md and the design rules: snippets and tokens first, one page per variant.">
          <textarea
            aria-label="Brief"
            className={cx(inputCls, "h-28 resize-none py-2 leading-relaxed")}
            value={brief}
            placeholder="Settings page with a left nav and a Git section…"
            onChange={(e) => setBrief(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
