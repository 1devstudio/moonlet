// The project page's Copied between your Macs (X74): the files git ignores
// that moonlet copies to the user's other Macs, `.env` by default. Each
// change is saved at once to the account state, so every Mac has it.

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { COPIED_NOTE, addPattern, listNote, listSaver, removePattern, type CopiedFiles } from "../../lib/copiedFiles";
import { M } from "../../lib/protocol";
import { errorToast } from "../../lib/store";
import { Button, IconButton, cx } from "../ui";
import { Card, Section, SwitchRow, fieldCls } from "./controls";

export function CopiedFilesSection({ host, id }: { host: string; id: string }) {
  const [list, setList] = useState<CopiedFiles | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saver = useRef<ReturnType<typeof listSaver<CopiedFiles>> | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    saver.current = null;
    rpc<CopiedFiles>(host, M.projectCopiedFilesGet, { id }).then(
      (l) => {
        if (!live) return;
        saver.current = listSaver(l, (v) => rpc(host, M.projectCopiedFilesSet, { id, patterns: v.patterns, cloud: v.cloud }));
        setList(l);
      },
      () => live && setList(null),
    );
    return () => {
      live = false;
    };
  }, [host, id]);
  if (!list) return null;
  // Each edit shows at once; saves go in order, and a failed one puts
  // back the list last saved unless a later edit was made.
  const save = (patterns: string[], cloud: boolean) => {
    const s = saver.current;
    if (!s) return;
    const next = { patterns, cloud, default: false };
    setList(next);
    void s(next, (e, saved) => {
      if (saver.current !== s) return;
      setList(saved);
      errorToast(e);
    });
  };
  const add = () => {
    const r = addPattern(list.patterns, draft);
    if ("error" in r) return setError(r.error);
    setError(null);
    setDraft("");
    save(r.patterns, list.cloud);
  };
  const note = listNote(list);
  return (
    <Section title="Copied between your Macs" hint={COPIED_NOTE}>
      <Card>
        <div data-setting="project-copied-files" className="flex flex-col gap-2.5 px-4 py-3.5">
          {list.patterns.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono ui-text-12.5">{p}</span>
              <IconButton title={`Remove ${p}`} onClick={() => save(removePattern(list.patterns, p), list.cloud)}>
                <X size={14} />
              </IconButton>
            </div>
          ))}
          {list.patterns.length === 0 && <span className="ui-text-12 text-faint">None. No file is copied.</span>}
          {note && <span className="ui-text-12 text-faint">{note}</span>}
          <div className="flex items-center gap-2">
            <input
              aria-label="Pattern to copy"
              className={cx(fieldCls, "w-[300px] font-mono ui-text-12.5", !!error && "border-error focus:border-error")}
              spellCheck={false}
              value={draft}
              placeholder=".env.local"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button size="sm" onClick={add}>
              <Plus size={12} /> Add
            </Button>
          </div>
          {error && <span className="ui-text-12 text-error">{error}</span>}
        </div>
        <SwitchRow
          setting="project-copied-files-cloud"
          label="Also to cloud machines"
          hint="A routed command's cloud machine gets these files too."
          on={list.cloud}
          onChange={(cloud) => save(list.patterns, cloud)}
        />
      </Card>
    </Section>
  );
}
