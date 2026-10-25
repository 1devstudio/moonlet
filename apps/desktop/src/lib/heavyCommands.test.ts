import { describe, expect, it } from "vitest";
import { approvalBanner, approvedToast, entryStates, heavyChanged, heavyDraft, heavyFromDraft, needsApproval, secretWarning, workerApproval } from "./heavyCommands";
import type { HeavyInfo } from "./protocol";

const info = (commands: string[], env: string[], approved: HeavyInfo["approved"]): HeavyInfo => ({
  config: { commands, os: "any", env, outputs: ["coverage"] },
  approved,
  error: null,
});

describe("the project page's Heavy commands (X62)", () => {
  it("a new entry, a changed entry, all approved", () => {
    const approved = { commands: ["pnpm build", "pnpm test"], env: ["CI"] };
    // All approved: no banner.
    const all = info(["pnpm test", "pnpm build"], ["CI"], approved);
    expect(entryStates(all)).toEqual([
      { command: "pnpm test", approved: true },
      { command: "pnpm build", approved: true },
    ]);
    expect(needsApproval(all)).toBe(false);
    expect(approvalBanner(all, ["studio-mini", "this Mac"])).toBeNull();

    // A new entry.
    const added = info(["pnpm test", "pnpm build", "pnpm lint"], ["CI"], approved);
    expect(entryStates(added)[2]).toEqual({ command: "pnpm lint", approved: false });
    expect(approvalBanner(added, ["studio-mini", "this Mac", "devbox"])).toEqual({
      title: "pnpm lint was added since you approved the list",
      text: "Approving the list lets agents run it without asking, on studio-mini, this Mac and devbox. Approved commands can run code from the project, including code the agent wrote, on this Mac.",
    });

    // A changed entry reads as a new one, and the old one has gone.
    const changed = info(["pnpm vitest", "pnpm build"], ["CI"], approved);
    expect(entryStates(changed)).toEqual([
      { command: "pnpm vitest", approved: false },
      { command: "pnpm build", approved: true },
    ]);
    expect(approvalBanner(changed, ["studio-mini"])?.title).toBe("pnpm vitest was added since you approved the list");

    // Removing one needs no approval.
    expect(needsApproval(info(["pnpm test"], ["CI"], approved))).toBe(false);

    // A new variable name needs it too.
    const env = info(["pnpm test"], ["CI", "NPM_TOKEN"], approved);
    expect(approvalBanner(env, ["studio-mini"])?.title).toBe("NPM_TOKEN was added to Pass to the worker since you approved the list");

    // Never approved.
    expect(approvalBanner(info(["pnpm test", "pnpm build"], [], null), ["studio-mini"])?.title).toBe("pnpm test and pnpm build are not approved yet");
  });

  it("the secret-looking env warning", () => {
    expect(secretWarning("NPM_TOKEN")).toBe("NPM_TOKEN looks like a secret. It reaches every machine that runs these commands, cloud machines too.");
    for (const name of ["AWS_SECRET_ACCESS_KEY", "STRIPE_SECRET", "DB_PASSWORD", "api_key"]) expect(secretWarning(name)).not.toBeNull();
    for (const name of ["CI", "NODE_ENV", "TOKENIZER_PATH"]) expect(secretWarning(name)).toBeNull();
  });

  it("the approval toast names every machine it covers", () => {
    expect(approvedToast("shop", ["pnpm test", "pnpm build"], ["studio-mini", "this Mac", "devbox"], [])).toBe(
      "Approved pnpm test and pnpm build for shop on studio-mini, this Mac and devbox",
    );
    expect(approvedToast("shop", ["pnpm test"], ["studio-mini"], [])).toBe("Approved pnpm test for shop on studio-mini");
  });

  it("a worker that was not reachable is named in the toast", () => {
    expect(approvedToast("shop", ["pnpm test"], ["studio-mini", "this Mac"], ["devbox"])).toBe(
      "Approved for shop on studio-mini and this Mac. devbox was not reachable; approve it from Workers.",
    );
  });
});

describe("editing Heavy commands on the project page (X62)", () => {
  it("turns the table into a form and back, trimming and dropping blank entries", () => {
    const draft = heavyDraft({ commands: ["pnpm test"], os: "linux", env: ["CI", "NPM_TOKEN"], outputs: ["coverage", "dist"] });
    expect(draft).toEqual({ commands: ["pnpm test"], os: "linux", env: "CI, NPM_TOKEN", outputs: "coverage, dist" });
    expect(heavyFromDraft({ commands: [" pnpm build ", "", "pnpm test"], os: "any", env: " CI ,, NPM_TOKEN", outputs: "" })).toEqual({
      commands: ["pnpm build", "pnpm test"],
      os: "any",
      env: ["CI", "NPM_TOKEN"],
      outputs: [],
    });
    expect(heavyDraft(undefined)).toEqual({ commands: [], os: "any", env: "", outputs: "" });
    expect(heavyChanged(draft, { ...draft, env: "CI,NPM_TOKEN" })).toBe(false);
    expect(heavyChanged(draft, { ...draft, commands: ["pnpm test", "pnpm build"] })).toBe(true);
  });
});

describe("approving on a worker from the Workers page (X62)", () => {
  it("shows the exact commands and variable names first", () => {
    expect(workerApproval("shop", "devbox", info(["pnpm test", "pnpm build"], ["CI", "NPM_TOKEN"], null))).toEqual({
      title: "Approve shop's heavy commands on devbox",
      message:
        "devbox will run these for shop without asking. Approved commands can run code from the project, including code the agent wrote, on devbox. NPM_TOKEN looks like a secret. It reaches every machine that runs these commands, cloud machines too.",
      action: "Approve",
      code: "pnpm test\npnpm build\n\nPass to the worker: CI, NPM_TOKEN",
    });
    expect(workerApproval("shop", "devbox", info(["pnpm test"], [], null)).code).toBe("pnpm test");
  });
});
