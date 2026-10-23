// Approving a project's heavy commands (X62) on its host and on every
// worker this app reaches that takes them for that host: this Mac, and
// remote hosts linked to it (X61). Each machine keeps its own approval.

import { rpc } from "./daemon";
import { approvedToast } from "./heavyCommands";
import { M, type HeavyInfo, type HostInfo, type LinkInfo, type ProjectIdentity } from "./protocol";

export interface Approved {
  info: HeavyInfo;
  toast: string;
}

/** Approves `info`'s lists for project `id` on `host`, then on the workers
 * the app reaches. */
export async function approveHeavy(host: string, id: string, project: { name: string; identity?: ProjectIdentity | null }, info: HeavyInfo, hosts: HostInfo[]): Promise<Approved> {
  const lists = { commands: info.config.commands, env: info.config.env };
  const next = await rpc<HeavyInfo>(host, M.heavyApprove, { project: id, ...lists });
  const label = (h: string) => (h === "local" ? "this Mac" : (hosts.find((x) => x.id === h)?.label ?? h));
  const machines = [label(host)];
  const unreachable: string[] = [];
  if (host !== "local" && project.identity?.root) {
    const workers = ["local", ...hosts.filter((h) => h.remote && h.kind === "tailnet" && h.id !== host && h.status === "connected").map((h) => h.id)];
    for (const w of workers) {
      const link = await rpc<LinkInfo>(w, M.linkGet).catch(() => null);
      if (link?.central?.name !== host || !link.worker.enabled) continue;
      const ok = await rpc(w, M.heavyApprove, { identity: project.identity, ...lists }).then(
        () => true,
        () => false,
      );
      (ok ? machines : unreachable).push(label(w));
    }
  }
  return { info: next, toast: approvedToast(project.name, lists.commands, machines, unreachable) };
}

/** The machines an approval of a project on `host` would cover, for the banner. */
export function approvalMachines(host: string, hosts: HostInfo[], localLink: LinkInfo | null): string[] {
  const label = (h: string) => (h === "local" ? "this Mac" : (hosts.find((x) => x.id === h)?.label ?? h));
  const out = [label(host)];
  if (host !== "local" && localLink?.central?.name === host && localLink.worker.enabled) out.push("this Mac");
  return out;
}
