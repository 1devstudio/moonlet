// The sidebar banner about a newer Claude Code and its `claude update` run
// (X36). Pure: the RPCs and the npm request live in the store.

/** Where a `claude update` run is: checking, or downloading and installing. */
export type ClaudeUpdateStep = "check" | "install";

export type ClaudeUpdateState =
  | { phase: "idle" }
  | { phase: "available"; installed: string; latest: string }
  | { phase: "updating"; installed: string; latest: string; step: ClaudeUpdateStep }
  | { phase: "updated"; version: string }
  | { phase: "current"; version: string }
  | { phase: "failed"; installed: string; latest: string; step: ClaudeUpdateStep; message: string };

/** What `claude.update` returned, or why the daemon could not run it. */
export type ClaudeUpdateRun = { ok: boolean; output: string } | { error: string };

/** The versions a check found; null where it could not tell. */
export interface ClaudeVersions {
  installed: string | null;
  latest: string | null;
}

/** Whether version `a` is newer than `b`, compared number by number. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The banner after a check. `dismissed` is the release the user said
 *  Later to. A running update, and its result until the user closes it,
 *  stay: a check that began before the update ended reads the old version. */
export function afterClaudeCheck(prev: ClaudeUpdateState, v: ClaudeVersions & { updating?: boolean }, dismissed: string | null): ClaudeUpdateState {
  if (prev.phase !== "idle" && prev.phase !== "available") return prev;
  const { installed, latest } = v;
  // Started by another window, or by this one before a reload.
  if (v.updating && installed && latest) return { phase: "updating", installed, latest, step: "check" };
  if (!installed || !latest || latest === dismissed || !isNewer(latest, installed)) return { phase: "idle" };
  return { phase: "available", installed, latest };
}

/** Follows `claude update`'s output: the native updater says "Updating to
 *  X...", the npm one "New version available" and "Installing update...". */
export function afterClaudeUpdateLine(s: ClaudeUpdateState, line: string): ClaudeUpdateState {
  if (s.phase !== "updating") return s;
  if (/^(Updating to |New version available|Installing update)/.test(line.trim())) return { ...s, step: "install" };
  return s;
}

/** The banner once `claude update` is over, and the release to hide from
 *  now on (the one announced, when the user's channel is behind it). */
export function afterClaudeUpdateExit(s: ClaudeUpdateState, run: ClaudeUpdateRun): { state: ClaudeUpdateState; dismiss: string | null } {
  if (s.phase !== "updating") return { state: s, dismiss: null };
  const failed = (message: string) => ({ state: { ...s, phase: "failed" as const, message }, dismiss: null });
  if ("error" in run) return failed(run.error);
  // Colours are off when stdout is a pipe, but strip them to be sure.
  const lines = run.output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trimEnd());
  for (const l of lines) {
    const updated = /^Successfully (?:updated|downgraded) from \S+ to version (\S+)/.exec(l);
    if (updated) return { state: { phase: "updated", version: updated[1] }, dismiss: null };
    const current = /^Claude Code is up to date \((\S+)\)/.exec(l);
    if (current) return { state: { phase: "current", version: current[1] }, dismiss: s.latest };
  }
  const checked = lines.findIndex((l) => l.startsWith("Checking for updates"));
  const said = lines.slice(checked + 1).filter((l) => l.trim() && !l.startsWith("Current version:"));
  return failed(said.join("\n") || "claude update failed");
}

export type StepState = "done" | "active" | "todo";

/** A banner button: Later hides the release, Update (or Retry) runs
 *  `claude update`. */
export interface ClaudeBannerButton {
  label: string;
  action: "later" | "update";
}

/** What the sidebar banner shows. */
export interface ClaudeBanner {
  tone: "info" | "progress" | "success" | "error";
  title: string;
  detail: string;
  steps: { label: string; state: StepState }[] | null;
  buttons: ClaudeBannerButton[];
  /** A close button: results stay until the user closes them. */
  closable: boolean;
}

/** The banner for a state; null hides it. */
export function claudeBanner(s: ClaudeUpdateState): ClaudeBanner | null {
  const banner = (tone: ClaudeBanner["tone"], title: string, detail: string, buttons: ClaudeBannerButton[] = []): ClaudeBanner => ({
    tone,
    title,
    detail,
    steps: null,
    buttons,
    closable: tone === "success" || tone === "error",
  });
  switch (s.phase) {
    case "idle":
      return null;
    case "available":
      return banner("info", `Claude Code ${s.latest} is available`, `You have ${s.installed}`, [
        { label: "Later", action: "later" },
        { label: "Update", action: "update" },
      ]);
    case "updating": {
      const installing = s.step === "install";
      return {
        ...banner("progress", "Updating Claude Code", `${s.installed} → ${s.latest}`),
        steps: [
          { label: "Check for updates", state: installing ? "done" : "active" },
          { label: "Download and install", state: installing ? "active" : "todo" },
          { label: "Done", state: "todo" },
        ],
      };
    }
    case "updated":
      return banner("success", `Claude Code updated to ${s.version}`, `New agents start on ${s.version}.`);
    case "current":
      return banner("success", `Claude Code ${s.version} is up to date`, "");
    case "failed":
      return banner("error", "Claude Code update failed", s.message, [{ label: "Retry", action: "update" }]);
  }
}

/** Later hides the announced release until a newer one is out; closing a
 *  result only hides the banner, so a failed release comes back at the next
 *  check. */
export function closeClaudeBanner(s: ClaudeUpdateState, how: "later" | "close"): { state: ClaudeUpdateState; dismiss: string | null } {
  return { state: { phase: "idle" }, dismiss: how === "later" && s.phase === "available" ? s.latest : null };
}

/** The status next to the Claude Code version in Settings › Updates. It
 *  goes by the versions, so a release the user said Later to still shows. */
export function claudeStatus(s: ClaudeUpdateState, v: ClaudeVersions, checking: boolean): string | null {
  if (checking) return "Checking…";
  if (s.phase === "updating") return "Updating…";
  if (!v.latest) return null;
  if (!v.installed) return "Not found on the PATH";
  return isNewer(v.latest, v.installed) ? `${v.latest} is available` : "Up to date";
}

/** The release Settings › Updates offers to update to; null for none. */
export function claudeOffer(s: ClaudeUpdateState, v: ClaudeVersions): string | null {
  const { installed, latest } = v;
  return s.phase !== "updating" && installed && latest && isNewer(latest, installed) ? latest : null;
}
