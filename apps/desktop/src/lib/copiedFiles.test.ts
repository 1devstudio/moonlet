import { describe, expect, it } from "vitest";
import { addPattern, copiedLine, keptToast, listNote, listSaver, loadFailedNote, removePattern, skippedLine } from "./copiedFiles";

describe("a project's copied files (X74)", () => {
  it("the_default_list_is_env_and_env_star", () => {
    expect(listNote({ patterns: [".env", ".env.*"], cloud: false, default: true })).toBe("The default: .env files in any folder.");
    expect(listNote({ patterns: ["config/local.yaml"], cloud: false, default: false })).toBeNull();
  });

  it("adds a pattern once, trimmed", () => {
    expect(addPattern([".env"], "  config/local.yaml ")).toEqual({ patterns: [".env", "config/local.yaml"] });
    expect(addPattern([".env"], ".env")).toEqual({ error: ".env is already in the list." });
  });

  it("a_refused_pattern_says_why", () => {
    expect(addPattern([], "!.env")).toEqual({ error: "A pattern cannot take files back (!)." });
    expect(addPattern([], "../secrets")).toEqual({ error: "A pattern stays inside the worktree (..)." });
    expect(addPattern([], "~/.aws/credentials")).toEqual({ error: "A pattern is relative to the worktree." });
    expect(addPattern([], "   ")).toEqual({ error: "Type a pattern, such as .env.local." });
  });

  it("removes a pattern", () => {
    expect(removePattern([".env", ".env.*"], ".env")).toEqual([".env.*"]);
  });

  it("saves go one after another, and a failed one puts back what was last saved", async () => {
    const sent: string[] = [];
    const answers: Array<{ ok: () => void; fail: (e: Error) => void }> = [];
    const save = listSaver<string>("A", (v) => {
      sent.push(v);
      return new Promise<void>((ok, fail) => answers.push({ ok, fail }));
    });
    const failed: Array<[string, string]> = [];
    const onFail = (e: unknown, saved: string) => failed.push([(e as Error).message, saved]);
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // Two quick edits: the second waits for the first.
    const first = save("B", onFail);
    const second = save("C", onFail);
    await tick();
    expect(sent).toEqual(["B"]);
    // The first fails once the second was made: nothing is put back for it.
    answers[0].fail(new Error("offline"));
    await first;
    await tick();
    expect(sent).toEqual(["B", "C"]);
    answers[1].ok();
    await second;
    expect(failed).toEqual([]);

    // A later edit fails: the list goes back to C, the last one saved.
    const third = save("D", onFail);
    await tick();
    answers[2].fail(new Error("forbidden"));
    await third;
    expect(failed).toEqual([["forbidden", "C"]]);
  });

  it("a list that could not be loaded says why", () => {
    expect(loadFailedNote("unknown method: project.copied_files.get")).toBe("Could not load this project's copied files: unknown method: project.copied_files.get");
  });
});

describe("copied files in the sync popover and toasts (X74)", () => {
  it("the_popover_counts_copied_files_and_lists_skipped_ones", () => {
    expect(copiedLine({ files: [".env", ".env.local", "apps/web/.env"], skipped: [] })).toBe("3 copied files");
    expect(copiedLine({ files: [".env"], skipped: [] })).toBe("1 copied file");
    expect(copiedLine({ files: [], skipped: [] })).toBeNull();
    expect(skippedLine({ path: "secrets.json", reason: "is over 1 MiB" })).toBe("secrets.json is over 1 MiB and stays on each Mac.");
  });

  it("says where this Mac's version went when the other side's won", () => {
    expect(keptToast({ label: "fix-cart", path: ".env.local", folder: "/Users/me/.moonlet/sync-leftovers/fix-cart-20261030-0102" }, "/Users/me")).toBe(
      "fix-cart: .env.local changed on both Macs. This Mac's version is in ~/.moonlet/sync-leftovers/fix-cart-20261030-0102",
    );
  });
});
