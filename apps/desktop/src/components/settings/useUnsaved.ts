// Unsaved edits on a workspace or project page (X43): leaving asks first
// (the leave guard), and ⌘↵ saves.

import { useEffect, useRef } from "react";
import { closeRequest } from "../../lib/projectSettings";
import { setLeaveGuard } from "../../lib/settingsNavigation";

export function useUnsaved(state: { dirty: boolean; saving: boolean; message: string }, save: () => void) {
  const current = useRef(state);
  current.current = state;
  const saveNow = useRef(save);
  saveNow.current = save;
  useEffect(() => {
    setLeaveGuard(() => ({ state: closeRequest({ saving: current.current.saving, parseError: false, dirty: current.current.dirty }), message: current.current.message }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      if (document.querySelector('[role="dialog"]:not([inert] *)')) return;
      e.preventDefault();
      e.stopPropagation();
      saveNow.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
}
