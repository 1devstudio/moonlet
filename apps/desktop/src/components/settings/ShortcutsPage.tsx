// Settings › Keyboard shortcuts (X43): every Run action (X19) with its key.
// Clicking a key records a new one; a custom key can go back to its default.

import { useEffect, useState } from "react";
import { Search, Undo2 } from "lucide-react";
import { askConfirm } from "../../lib/confirm";
import { ACTIONS, assignShortcut, effectiveKeys, keyId, keyLabel, keyParts, recordKey, resetShortcut, shortcutGroups } from "../../lib/runActions";
import { updateSettings, useStore } from "../../lib/store";
import { Button, IconButton, cx } from "../ui";
import { Card, PageHeading, Section } from "./controls";

const label = (id: string) => ACTIONS.find((a) => a.id === id)?.label ?? id;

/** A shortcut as keycaps, one per key: ⇧ ⌘ N. */
function Keycaps({ id }: { id: string }) {
  return (
    <span className="flex items-center gap-[3px]">
      {keyParts(id).map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[4px] border border-border-strong bg-raised px-[5px] font-sans ui-text-11.5 font-medium leading-none text-fg shadow-[0_1px_0_0_var(--color-border-strong)]"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutsPage() {
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null);
  const groups = shortcutGroups(shortcuts, query);
  const keys = effectiveKeys(shortcuts);
  const save = (next: typeof shortcuts) => updateSettings({ shortcuts: next });

  // While recording, every key goes to the recorder, not the page or the app.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" || e.key === "Tab") return setRecording(null);
      const current = useStore.getState().settings.shortcuts;
      const r = recordKey(keyId(e), recording, current);
      if (r.kind === "wait") return;
      if (r.kind === "error") return setRefusal({ id: recording, message: r.message });
      const action = recording;
      setRecording(null);
      setRefusal(null);
      if (r.kind === "ok") return save(assignShortcut(current, action, r.keys));
      void askConfirm({
        title: "Shortcut in use",
        message: `${keyLabel(r.keys)} is already used by ${label(r.other)}. Move it to ${label(action)}? ${label(r.other)} will have no shortcut.`,
        action: "Move",
      }).then((ok) => ok && save(assignShortcut(useStore.getState().settings.shortcuts, action, r.keys, r.other)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetAll = async () => {
    if (!(await askConfirm({ title: "Reset all shortcuts", message: "Every action gets its default key back.", action: "Reset all" }))) return;
    save({});
  };

  return (
    <>
      <PageHeading
        title="Keyboard shortcuts"
        aside={
          <Button size="sm" variant="ghost" disabled={!Object.keys(shortcuts ?? {}).length} onClick={() => void resetAll()}>
            Reset all
          </Button>
        }
      >
        Every action in Run action (⌘K). Click a shortcut to record a new one.
      </PageHeading>
      <label className="flex h-[34px] items-center gap-2 rounded-lg border border-border-strong bg-panel-2 px-3 text-faint">
        <Search size={13} />
        <input
          type="search"
          aria-label="Filter shortcuts"
          placeholder="Filter by action or key"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent ui-text-13 text-fg outline-none placeholder:text-faint"
        />
      </label>
      {groups.length === 0 && <p className="m-0 px-0.5 ui-text-13 text-muted">No action matches “{query}”.</p>}
      {groups.map((g) => (
        <Section key={g.name} title={g.name}>
          <Card>
            {g.rows.map((r) => {
              const rec = recording === r.id;
              return (
                <div key={r.id} data-setting={`shortcut-${r.id}`} className="flex flex-col">
                  <div className="flex h-10 items-center gap-2.5 pl-4 pr-2">
                    <span className="flex-1 truncate ui-text-13">{r.label}</span>
                    {r.custom && (
                      <>
                        <span className="ui-text-11.5 text-faint">custom</span>
                        <IconButton title={`Reset ${r.label} to its default`} onClick={() => save(resetShortcut(shortcuts, r.id))}>
                          <Undo2 size={12} />
                        </IconButton>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`Shortcut for ${r.label}`}
                      data-recording-shortcut={rec ? r.id : undefined}
                      onClick={() => {
                        setRefusal(null);
                        setRecording(rec ? null : r.id);
                      }}
                      className={cx(
                        "flex h-7 min-w-[72px] items-center justify-end rounded-md px-1.5 ui-text-12",
                        rec
                          ? "justify-center border border-accent bg-selected px-2.5 text-accent-2"
                          : r.keys
                            ? "border border-transparent hover:border-border-strong hover:bg-panel-2"
                            : "justify-center border border-dashed border-border-strong px-2.5 text-faint hover:text-muted",
                      )}
                    >
                      {rec ? "Press a shortcut…" : r.keys ? <Keycaps id={keys[r.id]} /> : "Not set"}
                    </button>
                  </div>
                  {refusal?.id === r.id && (
                    <span role="alert" className="px-4 pb-2.5 ui-text-12 text-error">
                      {refusal.message}
                    </span>
                  )}
                </div>
              );
            })}
          </Card>
        </Section>
      ))}
      <p className="m-0 px-0.5 ui-text-12 text-muted">⌘K, ⌘C, ⌘V, ⌘Q and the other editing and window keys are fixed. Taking a key another action uses asks before moving it. Esc or Tab cancels recording.</p>
    </>
  );
}
