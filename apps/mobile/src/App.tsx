import { useEffect } from "react";
import { startApp, useApp } from "./lib/app";
import { Splash } from "./components/Splash";
import { TabBar } from "./components/TabBar";
import { HostsScreen } from "./screens/Hosts";
import { InboxScreen, useInbox } from "./screens/Inbox";
import { NewSessionScreen } from "./screens/NewSession";
import { SessionsScreen } from "./screens/Sessions";
import { TasksScreen } from "./screens/Tasks";
import { TaskScreen } from "./screens/Task";
import { PlanSheet } from "./screens/PlanSheet";
import { SessionScreen } from "./screens/Session";
import { DiffScreen } from "./screens/Diff";
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
  if (screen?.kind === "task") return <TaskScreen board={screen.board} task={screen.task} created={screen.created} />;
  if (screen?.kind === "session") return <SessionScreen host={screen.host} id={screen.id} tab={screen.tab} />;
  if (screen?.kind === "diff") return <DiffScreen host={screen.host} id={screen.id} path={screen.path} against={screen.against} />;
  // A plan opened from a session's chat sits over that session.
  if (screen?.kind === "plan" && screen.from?.kind === "session")
    return (
      <>
        <SessionScreen host={screen.from.host} id={screen.from.id} tab={screen.from.tab} />
        <PlanSheet host={screen.host} terminal={screen.terminal} ask={screen.ask} from={screen.from} />
      </>
    );
  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1">
        {tab === "inbox" && <InboxScreen />}
        {tab === "hosts" && <HostsScreen />}
        {tab === "sessions" && <SessionsScreen />}
        {tab === "tasks" && <TasksScreen />}
        {tab === "new" && <NewSessionScreen />}
      </main>
      <TabBar badge={inbox.needs.length} />
      {screen?.kind === "plan" && <PlanSheet host={screen.host} terminal={screen.terminal} ask={screen.ask} />}
    </div>
  );
}
