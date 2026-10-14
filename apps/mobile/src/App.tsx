import { useEffect } from "react";
import { startApp, useApp } from "./lib/app";
import { Splash } from "./components/Splash";
import { TabBar } from "./components/TabBar";
import { HostsScreen } from "./screens/Hosts";
import { InboxScreen, useInbox } from "./screens/Inbox";
import { PlanSheet } from "./screens/PlanSheet";
import { PairScreen, PairedScreen } from "./screens/Pair";

export default function App() {
  const ready = useApp((s) => s.ready);
  const paired = useApp((s) => Object.keys(s.hosts).length > 0);
  const tab = useApp((s) => s.tab);
  const screen = useApp((s) => s.screen);
  const inbox = useInbox();
  useEffect(() => {
    void startApp();
  }, []);

  if (!ready) return <Splash />;
  if (screen?.kind === "paired") return <PairedScreen name={screen.name} />;
  if (!paired) return <PairScreen first />;
  if (screen?.kind === "pair") return <PairScreen first={false} />;
  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1">
        {tab === "inbox" && <InboxScreen />}
        {tab === "hosts" && <HostsScreen />}
        {(tab === "sessions" || tab === "new") && <div className="p-6 text-muted">Coming in the next part of the stack.</div>}
      </main>
      <TabBar badge={inbox.needs.length} />
      {screen?.kind === "plan" && <PlanSheet host={screen.host} terminal={screen.terminal} ask={screen.ask} />}
    </div>
  );
}
