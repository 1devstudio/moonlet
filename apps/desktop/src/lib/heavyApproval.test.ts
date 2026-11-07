import { describe, expect, it } from "vitest";
import { approvalBanner, approvedToast } from "./heavyCommands";
import { approvalTargets, approvalScope } from "./heavyApproval";
import type { HeavyInfo, HostInfo, LinkInfo } from "./protocol";

const host = (id: string, label: string, status = "connected"): HostInfo => ({ id, label, remote: true, kind: "tailnet", status }) as unknown as HostInfo;
const link = (central: string | null, enabled = true, name = "w"): LinkInfo =>
  ({ central: central ? { name: central, addrs: [] } : null, worker: { id: `${name}-id`, name, enabled, slots: 2 }, state: { kind: "connected", since: 0 } }) as unknown as LinkInfo;

describe("who an approval covers (X62)", () => {
  it("the central host, this Mac and each connected host that takes its heavy commands", () => {
    const hosts = [host("studio-mini", "studio-mini"), host("devbox", "devbox"), host("nas", "nas"), host("old", "old", "disconnected")];
    const links = { local: link("studio-mini"), devbox: link("studio-mini"), nas: link("studio-mini", false), old: link("studio-mini") };
    expect(approvalTargets("studio-mini", hosts, links)).toEqual([
      { id: "studio-mini", label: "studio-mini" },
      { id: "local", label: "this Mac" },
      { id: "devbox", label: "devbox" },
    ]);
  });

  it("the remote hosts linked to this Mac, when this Mac is the central host", () => {
    const hosts = [host("devbox", "devbox"), host("studio-mini", "studio-mini")];
    const links = { local: link(null, false, "Alex's MacBook Pro"), devbox: link("Alex's MacBook Pro"), "studio-mini": link("someone-else") };
    expect(approvalTargets("local", hosts, links)).toEqual([
      { id: "local", label: "this Mac" },
      { id: "devbox", label: "devbox" },
    ]);
  });
});

describe("an approval kept in the account (X89)", () => {
  const heavy = (account: boolean): HeavyInfo => ({ config: { commands: ["pnpm check"], os: "any", env: [], outputs: [] }, approved: null, error: null, account });
  const targets = [
    { id: "studio-mini", label: "studio-mini" },
    { id: "local", label: "this Mac" },
  ];

  it("the approval toast names the account", () => {
    const scope = approvalScope(heavy(true), targets);
    // The account carries it; workers from before X89 still get their own.
    expect(scope.approveOn).toEqual(targets);
    expect(approvalBanner(heavy(true), scope.banner)?.text).toBe(
      "Approving the list lets agents run it without asking, on every host of your account that takes heavy commands. Approved commands can run code from the project, including code the agent wrote, on this Mac.",
    );
    expect(approvedToast("shop", ["pnpm check"], scope.toast!, [])).toBe("Approved pnpm check for shop on every host of your account");
    expect(approvedToast("shop", ["pnpm check"], scope.toast!, ["devbox"])).toBe(
      "Approved for shop on every host of your account. devbox was not reachable; approve it from Workers.",
    );
  });

  it("each machine, on a host from before X89", () => {
    const scope = approvalScope(heavy(false), targets);
    expect(scope).toEqual({ approveOn: targets, banner: ["studio-mini", "this Mac"], toast: null });
  });
});
