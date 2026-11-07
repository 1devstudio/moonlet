import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, TerminalInfo } from "./protocol";
import { loadAccount, selectSession, useStore } from "./store";

/** What the daemon answers, by host and method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);

vi.mock("./daemon", () => {
  class DaemonError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  }
  return {
    DaemonError,
    rpc: vi.fn((host: string, method: string, params: unknown) => {
      const answer = answers[`${host} ${method}`];
      return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
    }),
    onDaemonEvent: () => Promise.resolve(() => {}),
    onHostStatus: () => Promise.resolve(() => {}),
    subscribeHost: () => Promise.resolve(),
    hostsApi: {},
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  project_id: "p1",
  name: id,
  branch: `moonlet/${id}`,
  base: "",
  path: `/Users/me/.moonlet/copies/MacBook/shop/${id}`,
  agent: null,
  archived: false,
  created_at: 1700,
  workspace_id: "personal",
  terminals: [],
  layout: null,
  ...extra,
});
const book = { worker: "book-id", name: "MacBook", reachable: true };
const chat: TerminalInfo = {
  id: 3,
  kind: "agent",
  title: "Claude",
  cwd: "/Users/alex/w/fix-cart",
  command: ["claude"],
  session_id: "fix-cart",
  agent_state: "working",
  cols: 120,
  rows: 40,
  pid: 4242,
  chat: true,
  created_at: 1800,
  last_output_at: 1900,
};
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  useStore.setState({ sessions: {}, accounts: {}, projects: { local: [{ id: "p1", name: "shop", path: "/Users/me/shop", base_branch: "main" }] }, terminals: {}, selected: null });
  answers["local session.list"] = () => [session("own"), session("fix-cart", { owner: book })];
});

describe("the central host's app and the sessions other members run (X86)", () => {
  it("lists them once its daemon says it is the central host", async () => {
    answers["local account.get"] = () => ({ account: "mini-id", central: null });
    await loadAccount("local");
    await settle();
    expect(useStore.getState().sessions["local#copy:fix-cart"]).toEqual([session("fix-cart", { owner: book })]);
    expect(useStore.getState().sessions["local#copy:own"]).toBeUndefined();
  });

  it("lists none on a member of the account", async () => {
    answers["local account.get"] = () => ({ account: "mini-id", central: "studio-mini" });
    await loadAccount("local");
    await settle();
    expect(Object.keys(useStore.getState().sessions)).toEqual([]);
  });

  it("opens one with the terminals its member lists, through the copy host", async () => {
    answers["local account.get"] = () => ({ account: "mini-id", central: null });
    answers["local#copy:fix-cart terminal.list"] = () => [chat];
    answers["local#copy:fix-cart chat.summaries"] = () => [{ id: 3 }];
    await loadAccount("local");
    await settle();
    selectSession("local#copy:fix-cart", "fix-cart");
    await settle();
    expect(useStore.getState().terminals["local#copy:fix-cart"]).toEqual({ 3: chat });
    expect(useStore.getState().sessions["local#copy:fix-cart"]?.[0]?.terminals).toEqual([3]);
  });
});
