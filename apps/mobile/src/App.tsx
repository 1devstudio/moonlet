import { useEffect } from "react";
import { startApp, useApp } from "./lib/app";
import { TabBar } from "./components/TabBar";
import { HostsScreen } from "./screens/Hosts";
import { PairScreen } from "./screens/Pair";

export default function App() {
  const ready = useApp((s) => s.ready);
  const paired = useApp((s) => Object.keys(s.hosts).length > 0);
  const tab = useApp((s) => s.tab);
  const screen = useApp((s) => s.screen);
  useEffect(() => {
    void startApp();
  }, []);

  if (!ready) return null;
  if (!paired) return <PairScreen first />;
  if (screen?.kind === "pair") return <PairScreen first={false} />;
  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1">
        {tab === "hosts" && <HostsScreen />}
        {tab !== "hosts" && <div className="p-6 text-muted">Coming in the next part of the stack.</div>}
      </main>
      <TabBar badge={0} />
    </div>
  );
}
