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

/** The machines an approval of a project on `host` covers: `host`, then
 * every worker the app reaches that takes heavy commands for it, by their
 * `link.get` (`links`, by host id). The banner names them, and Approve
 * approves on each. */
export function approvalTargets(host: string, hosts: HostInfo[], links: Record<string, LinkInfo | null>): { id: string; label: string }[] {
  const label = (h: string) => (h === "local" ? "this Mac" : (hosts.find((x) => x.id === h)?.label ?? h));
  // Workers name their central host as it names itself.
  const central = host === "local" ? links.local?.worker.name : host;
  const reached = ["local", ...hosts.filter((h) => h.remote && h.kind === "tailnet" && h.status === "connected").map((h) => h.id)];
  const workers = reached.filter((w) => w !== host && !!central && links[w]?.central?.name === central && links[w]?.worker.enabled);
  return [host, ...workers].map((id) => ({ id, label: label(id) }));
}

/** The `link.get` of this Mac and of each connected tailnet host. */
export async function readLinks(hosts: HostInfo[]): Promise<Record<string, LinkInfo | null>> {
  const ids = ["local", ...hosts.filter((h) => h.remote && h.kind === "tailnet" && h.status === "connected").map((h) => h.id)];
  const links = await Promise.all(ids.map((id) => rpc<LinkInfo>(id, M.linkGet).catch(() => null)));
  return Object.fromEntries(ids.map((id, i) => [id, links[i]]));
}

/** Approves `info`'s lists for project `id` on `host`, then on the workers
 * [`approvalTargets`] names. */
export async function approveHeavy(
  host: string,
  id: string,
  project: { name: string; identity?: ProjectIdentity | null },
  info: HeavyInfo,
  hosts: HostInfo[],
  links: Record<string, LinkInfo | null>,
): Promise<Approved> {
  const lists = { commands: info.config.commands, env: info.config.env };
  const next = await rpc<HeavyInfo>(host, M.heavyApprove, { project: id, ...lists });
  const [first, ...workers] = approvalTargets(host, hosts, links);
  const machines = [first.label];
  const unreachable: string[] = [];
  if (project.identity?.root) {
    for (const w of workers) {
      const ok = await rpc(w.id, M.heavyApprove, { identity: project.identity, ...lists }).then(
        () => true,
        () => false,
      );
      (ok ? machines : unreachable).push(w.label);
    }
  }
  return { info: next, toast: approvedToast(project.name, lists.commands, machines, unreachable) };
}
