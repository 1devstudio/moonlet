import { describe, expect, it } from "vitest";
import { copyLabel, copyNotice, designHost, moveConfirm, ownerWorking, sessionDesignsAcross } from "./designCopies";
import type { HostWorkspaces } from "./workspaces";

const host = (id: string, account: string | undefined, ids: string[]): HostWorkspaces => ({
  host: id,
  label: id,
  account,
  workspaces: ids.map((wid) => ({ id: wid, name: wid, section_ids: [] }) as unknown as HostWorkspaces["workspaces"][number]),
  sections: [],
  sessions: [],
  profiles: [],
});

describe("designHost (X71)", () => {
  it("reads a shared workspace's designs from this Mac, which holds a copy of each", () => {
    const hosts = [host("local", "acct-1", ["w-mini", "w-book"]), host("studio-mini", "acct-1", ["w-mini", "w-book"])];
    expect(designHost({ host: "studio-mini", id: "w-mini", account: "acct-1" }, hosts)).toBe("local");
  });

  it("reads them from the shown host when this Mac is not of its account", () => {
    const hosts = [host("local", "acct-1", ["w-book"]), host("lab-vps", "acct-2", ["w-lab"])];
    expect(designHost({ host: "lab-vps", id: "w-lab", account: "acct-2" }, hosts)).toBe("lab-vps");
  });

  it("reads them from the shown host while this Mac's daemon is not connected", () => {
    const hosts = [host("local", "acct-1", ["w-mini"]), host("studio-mini", "acct-1", ["w-mini"])];
    expect(designHost({ host: "studio-mini", id: "w-mini", account: "acct-1" }, hosts, false)).toBe("studio-mini");
  });

  it("reads them from the shown host while this Mac does not list the workspace yet", () => {
    const hosts = [host("local", "acct-1", ["w-book"]), host("studio-mini", "acct-1", ["w-book", "w-new"])];
    expect(designHost({ host: "studio-mini", id: "w-new", account: "acct-1" }, hosts)).toBe("studio-mini");
  });
});

describe("a copy's labels (X71)", () => {
  const copy = { owner: { worker: "7d3f1c2a", name: "studio-mini" }, owner_agent: false };
  const own = { owner: null, owner_agent: false };

  it("names the host it is from, and nothing for this Mac's own", () => {
    expect(copyLabel(copy)).toBe("from studio-mini");
    expect(copyNotice(copy)).toBe("A copy from studio-mini · read only");
    expect(copyLabel(own)).toBeNull();
    expect(copyNotice(own)).toBeNull();
    // A daemon from before X71 says nothing of owners.
    expect(copyLabel({})).toBeNull();
  });

  it("says where the owner's agent works while it does", () => {
    expect(ownerWorking({ ...copy, owner_agent: true }, "system")).toBe("Syncing on studio-mini");
    expect(ownerWorking({ ...copy, owner_agent: true }, "design")).toBe("Working on studio-mini");
    expect(ownerWorking(copy, "system")).toBeNull();
  });

  it("asks before moving, and offers Move anyway while the owner looks busy", () => {
    expect(moveConfirm("Acme web", { ...copy, owner_agent: false }, "system")).toEqual({
      title: "Move Acme web here?",
      body: "Its sync agent will run on this Mac from now on, with this Mac's clones of its projects. studio-mini keeps a read-only copy.",
      confirm: "Move here",
      force: false,
    });
    expect(moveConfirm("Checkout", { ...copy, owner_agent: true }, "design")).toEqual({
      title: "Move Checkout here?",
      body: "studio-mini looks busy: its agent is working on it, and its changes since the last snapshot stay there. Its agent will run on this Mac from now on. studio-mini keeps a read-only copy.",
      confirm: "Move anyway",
      force: true,
    });
  });
});

describe("session designs across members (X71)", () => {
  it("lists each member's session designs with the host its session runs on, and waits for this Mac's", () => {
    const d = (session: string, slug: string) => ({ session, slug }) as never;
    const lists: Record<string, never[] | undefined> = { local: [d("s-1", "checkout")], "studio-mini": [d("s-7", "billing")], "lab-vps": undefined };
    expect(sessionDesignsAcross(["local", "studio-mini", "lab-vps"], (h) => lists[h])).toEqual([
      { host: "local", design: d("s-1", "checkout") },
      { host: "studio-mini", design: d("s-7", "billing") },
    ]);
    expect(sessionDesignsAcross(["lab-vps"], (h) => lists[h])).toBeUndefined();
  });
});
