import { describe, expect, it } from "vitest";
import { hostWorkspaces, inShown, shownWorkspace, workspaceChoices } from "./workspaceChoices";
import { data, workspace } from "./fixtures";

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

  it("names no host while one host has every row", () => {
    const one = hostWorkspaces({ mac: { id: "mac", label: "This Mac" } }, { mac: data({ workspaces: [workspace("p1", "Personal"), workspace("w", "Work")] }) });
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

  it("takes a name kept before X68 as the first workspace of that name", () => {
    expect(shownWorkspace("Personal", world())).toEqual({ host: "mac", id: "p1", account: "w-mini" });
  });

  it("shows all workspaces once the chosen one is gone, or none was chosen", () => {
    expect(shownWorkspace({ host: "mac", id: "gone", account: "w-mini" }, world())).toBeNull();
    expect(shownWorkspace("Nowhere", world())).toBeNull();
    expect(shownWorkspace(null, world())).toBeNull();
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
