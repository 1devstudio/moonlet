import { describe, expect, it } from "vitest";
import { hostWorkspaces, inShown, isChosen, mergeAsk, mergeChoices, shownWorkspace, workspaceChoices } from "./workspaceChoices";
import { data, session, terminal, workspace } from "./fixtures";

/** X68's journey: the MacBook and studio-mini share studio-mini's account,
 * devbox has none. */
const world = () => {
  const hosts = {
    mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
    mini: { id: "mini", label: "studio-mini", status: "connected" as const, via: null },
    "mac/devbox": { id: "mac/devbox", label: "devbox", status: "connected" as const, via: "This Mac" },
  };
  const d = {
    mac: data({ account: "w-mini", workspaces: [{ ...workspace("p1", "Personal"), made_by: "MacBook" }, { ...workspace("acme", "Acme"), color: "blue" as const }] }),
    mini: data({ account: "w-mini", workspaces: [{ ...workspace("p1", "Personal"), made_by: "MacBook" }, { ...workspace("p2", "Personal"), color: "violet" as const, made_by: "studio-mini" }] }),
    "mac/devbox": data({ workspaces: [workspace("p1", "Personal")] }),
  };
  return hostWorkspaces(hosts, d);
};

describe("workspaceChoices", () => {
  it("lists an account's workspace once whichever members list it, same-name ones apart with their maker, and a host outside the account under its name", () => {
    expect(workspaceChoices(world()).map((c) => [c.ref, c.name, c.color, c.from, c.hostLabel])).toEqual([
      [{ host: "mac", id: "p1", account: "w-mini" }, "Personal", "clay", "MacBook", "This Mac"],
      [{ host: "mac", id: "acme", account: "w-mini" }, "Acme", "blue", null, null],
      [{ host: "mini", id: "p2", account: "w-mini" }, "Personal", "violet", "studio-mini", "studio-mini"],
      [{ host: "mac/devbox", id: "p1", account: "mac/devbox" }, "Personal", "clay", null, "devbox"],
    ]);
  });

  it("offers no workspace only a disconnected host lists, from the data it left", () => {
    const hosts = {
      mac: { id: "mac", label: "This Mac", status: "connected" as const },
      mini: { id: "mini", label: "studio-mini", status: "reconnecting" as const },
    };
    const d = { mac: data({ account: "w-mini", workspaces: [workspace("p1", "Personal")] }), mini: data({ account: "w-mini", workspaces: [workspace("p1", "Personal"), workspace("p2", "Experiments")] }) };
    expect(workspaceChoices(hostWorkspaces(hosts, d)).map((c) => c.name)).toEqual(["Personal"]);
    expect(shownWorkspace({ host: "mini", id: "p2", account: "w-mini" }, hostWorkspaces(hosts, d))).toBeNull();
  });

  it("names no host while one host has every row", () => {
    const one = hostWorkspaces({ mac: { id: "mac", label: "This Mac", status: "connected" } }, { mac: data({ workspaces: [workspace("p1", "Personal"), workspace("w", "Work")] }) });
    expect(workspaceChoices(one).map((c) => [c.name, c.hostLabel])).toEqual([
      ["Personal", null],
      ["Work", null],
    ]);
  });
});

describe("shownWorkspace", () => {
  it("keeps a workspace another member of its account still lists after its own host went", () => {
    const list = world().filter((h) => h.host !== "mac");
    expect(shownWorkspace({ host: "mac", id: "p1", account: "w-mini" }, list)).toEqual({ host: "mini", id: "p1", account: "w-mini" });
  });

  it("stays in its account when its own host left it, while another member lists it", () => {
    const list = world().map((h) => (h.host === "mac" ? { ...h, account: undefined } : h));
    expect(shownWorkspace({ host: "mac", id: "p1", account: "w-mini" }, list)).toEqual({ host: "mini", id: "p1", account: "w-mini" });
  });

  it("takes a name kept before X68 as the first workspace of that name", () => {
    expect(shownWorkspace("Personal", world())).toEqual({ host: "mac", id: "p1", account: "w-mini" });
  });

  it("shows all workspaces once the chosen one is gone, or none was chosen", () => {
    expect(shownWorkspace({ host: "mac", id: "gone", account: "w-mini" }, world())).toBeNull();
    expect(shownWorkspace("Nowhere", world())).toBeNull();
    expect(shownWorkspace(null, world())).toBeNull();
  });
});

describe("isChosen", () => {
  it("ticks the workspace shown, on whichever member of its account, or All workspaces", () => {
    const shown = { host: "mini", id: "p1", account: "w-mini" };
    expect(isChosen({ host: "mac", id: "p1", account: "w-mini" }, shown)).toBe(true);
    expect(isChosen({ host: "mac/devbox", id: "p1", account: "mac/devbox" }, shown)).toBe(false);
    expect(isChosen(null, shown)).toBe(false);
    expect(isChosen(null, null)).toBe(true);
  });
});

describe("inShown", () => {
  const shown = { host: "mac", id: "p1", account: "w-mini" };

  it("takes the workspace from every member of its account, and not a same-id one outside it", () => {
    expect(inShown(shown, "mini", "w-mini", "p1")).toBe(true);
    expect(inShown(shown, "mac/devbox", undefined, "p1")).toBe(false);
    expect(inShown(shown, "mini", "w-mini", "p2")).toBe(false);
  });

  it("takes everything while all workspaces show", () => {
    expect(inShown(null, "mac/devbox", undefined, "p1")).toBe(true);
  });
});

describe("mergeChoices and mergeAsk (X68)", () => {
  const choice = (list: ReturnType<typeof world>, host: string, id: string) => workspaceChoices(list).find((c) => c.row.host === host && c.ref.id === id)!;

  it("offers the other workspaces of the same account only", () => {
    const list = world();
    expect(mergeChoices(workspaceChoices(list), choice(list, "mini", "p2")).map((c) => [c.ref.host, c.name])).toEqual([
      ["mac", "Personal"],
      ["mac", "Acme"],
    ]);
    expect(mergeChoices(workspaceChoices(list), choice(list, "mac/devbox", "p1"))).toEqual([]);
  });

  it("asks a member that lists both, in the desktop's words", () => {
    const list = world();
    const d = { mini: data({ workspaces: [{ ...workspace("p1", "Personal"), section_ids: ["a"] }, { ...workspace("p2", "Personal"), section_ids: ["b"] }] }) };
    const ask = mergeAsk(choice(list, "mini", "p2"), choice(list, "mac", "p1"), d, []);
    expect(ask.host).toBe("mini");
    expect(ask.prompt).toEqual({
      title: "Merge workspaces",
      message: "Move the 1 section of this Personal, with its sessions, into the other Personal, and delete this one? Every Mac sharing them gets the change.",
      action: "Merge",
    });
  });

  it("leaves the profile out when the member could not list its profiles", () => {
    const list = world();
    const d = {
      mini: data({
        workspaces: [{ ...workspace("p1", "Personal"), claude_profile: "work" }, { ...workspace("p2", "Personal"), section_ids: ["b"] }],
        sessions: [session("refund", "Idempotent refund webhooks", { workspace_id: "p2" })],
        terminals: { 5: terminal(5, "refund") },
      }),
    };
    expect(mergeAsk(choice(list, "mini", "p2"), choice(list, "mac", "p1"), d, null).prompt.message).toBe(
      "Move the 1 section of this Personal, with its sessions, into the other Personal, and delete this one? Every Mac sharing them gets the change.",
    );
  });

  it("says what a new Claude profile does to agents running in the merged workspace", () => {
    const list = world();
    const d = {
      mini: data({
        workspaces: [{ ...workspace("p1", "Personal"), claude_profile: "work" }, { ...workspace("p2", "Personal"), section_ids: ["b"] }],
        sessions: [session("refund", "Idempotent refund webhooks", { workspace_id: "p2" })],
        terminals: { 5: terminal(5, "refund") },
      }),
    };
    const profiles = [{ id: "work", name: "Work", path: "/p/work", created_at: 0, account: null, hooks_installed: true }];
    expect(mergeAsk(choice(list, "mini", "p2"), choice(list, "mac", "p1"), d, profiles).prompt.message).toBe(
      "Move the 1 section of this Personal, with its sessions, into the other Personal, and delete this one? Every Mac sharing them gets the change. 1 session in this workspace has an agent. A running agent keeps its account until it restarts, then signs in with Work and starts a new conversation.",
    );
  });
});
