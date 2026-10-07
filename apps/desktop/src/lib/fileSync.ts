// An editor tab's text against its file on disk (X26). `saved` is the text
// last read or written; the tab is unsaved while the editor differs from it.

export interface ReadResult {
  saved: string;
  /** Replace the editor's text with the file's. */
  replace: boolean;
  dirty: boolean;
}

/** After reading the file: `editor` is the editor's text, null before it exists. */
export function afterRead(editor: string | null, saved: string, disk: string): ReadResult {
  if (editor === null || editor === disk) return { saved: disk, replace: false, dirty: false };
  // No unsaved edits: show what is on disk. Unsaved edits are kept.
  if (editor === saved) return { saved: disk, replace: true, dirty: false };
  return { saved, replace: false, dirty: true };
}

/** After writing `written`, with the editor now holding `editor`. */
export function afterSave(written: string, editor: string): { saved: string; dirty: boolean } {
  return { saved: written, dirty: editor !== written };
}
