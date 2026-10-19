// Settings › Git (X55): branches, worktrees and archiving, per host. Each
// host's daemon keeps its own, in `~/.moonlet/git.toml`.

import { useId, useState } from "react";
import { gitHosts, gitSettingsOf, tooOldText } from "../../lib/gitSettings";
import { setGitSettings, useStore } from "../../lib/store";
import { Card, PageHeading, Section, Segmented, SwitchRow } from "./controls";

function HostSwitch({ host, onChange }: { host: string; onChange: (host: string) => void }) {
  const hosts = useStore((s) => s.hosts);
  const options = gitHosts(hosts);
  const id = useId();
  if (options.length < 2) return null;
  return (
    <>
      <span id={id} className="sr-only">
        Host
      </span>
      <Segmented value={options.some((o) => o.id === host) ? host : "local"} options={options} onChange={onChange} labelledBy={id} />
    </>
  );
}

export function GitPage() {
  const [picked, setPicked] = useState("local");
  const connected = useStore((s) => gitHosts(s.hosts).some((o) => o.id === picked));
  const host = connected ? picked : "local";
  const stored = useStore((s) => s.gitSettings[host]);
  const label = useStore((s) => (host === "local" ? "This Mac" : (s.hosts[host]?.label ?? host)));
  const g = gitSettingsOf({ [host]: stored }, host);
  const tooOld = stored === null;
  const set = (patch: Parameters<typeof setGitSettings>[1]) => void setGitSettings(host, patch);
  return (
    <>
      <PageHeading title="Git" aside={<HostSwitch host={host} onChange={setPicked} />}>
        Branches, worktrees and archiving. Each host keeps its own, so sessions an agent opens follow them too.
      </PageHeading>
      {tooOld && <p className="m-0 rounded-md border border-[#4a3b17] bg-[#2a2210] px-3 py-2 ui-text-12.5 text-blocked">{tooOldText(label)}</p>}
      <Section title="Commits and pull requests">
        <Card>
          <SwitchRow setting="git-stage-all" label="Stage all changes before committing" hint="The Commit dialog's checkbox starts this way." on={g.stage_all} disabled={tooOld} onChange={(on) => set({ stage_all: on })} />
          <SwitchRow setting="git-draft-prs" label="Open pull requests as drafts" hint="Create pull request's Draft checkbox starts this way." on={g.draft_prs} disabled={tooOld} onChange={(on) => set({ draft_prs: on })} />
        </Card>
      </Section>
    </>
  );
}
