import { describe, expect, it } from "vitest";
import { approvalTargets } from "./heavyApproval";
import type { HostInfo, LinkInfo } from "./protocol";

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
