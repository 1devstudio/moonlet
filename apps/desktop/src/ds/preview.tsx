// Demo data for rendering moonlet's app screens outside the app (Claude Design,
// design-system previews). `MoonletPreview` seeds the app's stores before its
// children render; the Tauri stub answers daemon calls with the same data.

import { type ReactNode, useState } from "react";
import { chatKey, useChat } from "../lib/chat";
import type {
  ChatItem,
  ChatState,
  GitStatus,
  HostInfo,
  Project,
  PullRequest,
  Session,
  TerminalInfo,
  Section,
  Workspace,
} from "../lib/protocol";
import { sesKey, useStore } from "../lib/store";
import { setPreviewRpc } from "./tauri-stub";

export const DEMO_HOST = "local";
const NOW = Date.UTC(2026, 9, 3, 14, 30);
const ago = (min: number) => NOW - min * 60_000;

const host: HostInfo = {
  id: DEMO_HOST,
  label: "This Mac",
  remote: false,
  status: "connected",
  message: null,
  daemon_version: "0.1.3",
  hostname: "studio",
  home: "/Users/alex",
};

export const demoProjects: Project[] = [
  { id: "p-web", name: "storefront", path: "/Users/alex/code/storefront", base_branch: "main" },
  { id: "p-api", name: "payments-api", path: "/Users/alex/code/payments-api", base_branch: "main" },
];

function session(id: string, project: string, name: string, terminals: number[], minutesAgo: number, extra: Partial<Session> = {}): Session {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  return {
    id,
    project_id: project,
    name,
    branch: `moonlet/${slug}`,
    base: "main",
    path: `/Users/alex/.moonlet/worktrees/${project === "p-web" ? "storefront" : "payments-api"}/${slug}`,
    agent: "claude",
    archived: false,
    created_at: ago(minutesAgo),
    workspace_id: "w-main",
    model: "sonnet",
    effort: "high",
    terminals,
    layout: null,
    ...extra,
  };
}

export const demoSessions: Session[] = [
  session("s-checkout", "p-web", "Fix checkout button on mobile", [1, 2], 42),
  session("s-search", "p-web", "Add search to the product list", [3], 95),
  session("s-dark", "p-web", "Dark mode for account pages", [4], 300),
  session("s-refund", "p-api", "Idempotent refund endpoint", [5], 18),
  session("s-rate", "p-api", "Rate-limit webhook retries", [6], 600, { agent: "codex", model: null }),
];

function term(id: number, sessionId: string, extra: Partial<TerminalInfo>): TerminalInfo {
  const s = demoSessions.find((x) => x.id === sessionId)!;
  return {
    id,
    kind: "agent",
    title: "claude",
    cwd: s.path,
    command: ["claude"],
    session_id: sessionId,
    agent: "claude",
    agent_state: "idle",
    cols: 120,
    rows: 32,
    pid: 4100 + id,
    chat: true,
    created_at: s.created_at,
    last_output_at: s.created_at,
    ...extra,
  };
}

export const demoTerminals: TerminalInfo[] = [
  term(1, "s-checkout", { agent_state: "working", last_output_at: ago(1) }),
  term(2, "s-checkout", { kind: "shell", title: "zsh", command: ["/bin/zsh", "-l"], agent: undefined, chat: false, prompt: true }),
  term(3, "s-search", { agent_state: "blocked", agent_message: "Edit src/components/ProductList.tsx", last_output_at: ago(3) }),
  term(4, "s-dark", { agent_state: "done", last_output_at: ago(40) }),
  term(5, "s-refund", { agent_state: "working", last_output_at: ago(0.5) }),
  term(6, "s-rate", { agent: "codex", title: "codex", command: ["codex"], agent_state: "error", agent_message: "exited with code 1", last_output_at: ago(200) }),
];

export const demoSection: Section = {
  id: "sec-main",
  name: "Acme",
  project_ids: demoProjects.map((p) => p.id),
  view: { group_by: "project", sort_by: "recent", filter: [] },
  created_at: ago(10_000),
};

export const demoWorkspace: Workspace = {
  id: "w-main",
  name: "Personal",
  color: "clay",
  section_ids: [demoSection.id],
  created_at: ago(10_000),
};

function git(add: number, del: number, files: number): GitStatus {
  return {
    branch: null,
    head: null,
    upstream: null,
    ahead: 2,
    behind: 0,
    against: "main",
    files: Array.from({ length: files }, (_, i) => ({
      path: `src/file-${i}.ts`,
      status: "modified",
      staged: false,
      unstaged: true,
      additions: Math.round(add / files),
      deletions: Math.round(del / files),
      binary: false,
    })) as GitStatus["files"],
    additions: add,
    deletions: del,
  };
}

const demoGit: Record<string, GitStatus> = {
  [sesKey(DEMO_HOST, "s-checkout")]: git(48, 12, 3),
  [sesKey(DEMO_HOST, "s-search")]: git(212, 30, 6),
  [sesKey(DEMO_HOST, "s-dark")]: git(394, 120, 11),
  [sesKey(DEMO_HOST, "s-refund")]: git(87, 4, 2),
};

const demoPrs: Record<string, PullRequest | null> = {
  [sesKey(DEMO_HOST, "s-dark")]: { number: 128, url: "https://example.com/pr/128", state: "OPEN", title: "Dark mode for account pages", checks: [], review_decision: "APPROVED" },
};

const t = (min: number) => ago(min);

/** A short Claude conversation: a question, a tool run, an edit awaiting approval. */
export const demoChatItems: ChatItem[] = [
  { id: "u1", kind: "user", text: "The checkout button overflows on small screens. Can you fix it?", ts: t(6) },
  { id: "th1", kind: "thinking", text: "The button has a fixed width; check the styles first.", ts: t(6) },
  {
    id: "tool1",
    kind: "tool",
    text: "",
    ts: t(5),
    tool: { name: "Bash", summary: "rg -n \"checkout-button\" src", input: { command: "rg -n \"checkout-button\" src" }, output: "src/components/Checkout.tsx:41:  <button className=\"checkout-button\">\nsrc/styles/checkout.css:12:.checkout-button { width: 420px; }", status: "ok" },
  },
  {
    id: "tool2",
    kind: "tool",
    text: "",
    ts: t(4),
    tool: {
      name: "Edit",
      summary: "src/styles/checkout.css",
      input: { file_path: "src/styles/checkout.css" },
      status: "ok",
      diff: "--- src/styles/checkout.css\n+++ src/styles/checkout.css\n@@\n-.checkout-button { width: 420px; }\n+.checkout-button { width: 100%; max-width: 420px; }\n",
    },
  },
  {
    id: "a1",
    kind: "assistant",
    text: "The button had a fixed `width: 420px`. It now fills the container up to **420px**, so it fits on phones:\n\n```css\n.checkout-button { width: 100%; max-width: 420px; }\n```\n\nShall I also run the visual tests?",
    ts: t(3),
  },
];

export const demoChat: ChatState = {
  items: demoChatItems,
  pending: [],
  status: "done",
  model: "sonnet",
  effort: "high",
  mode: "default",
  cost_usd: 0.084,
  input_tokens: 41_200,
  output_tokens: 1_850,
  slash_commands: ["review", "compact", "init"],
  queued: [],
  context: {
    used: 124_200,
    max: 200_000,
    auto_compact_at: 190_000,
    categories: [
      { name: "System prompt", tokens: 8_100 },
      { name: "MCP tools", tokens: 18_400 },
      { name: "Memory files", tokens: 5_600 },
      { name: "Messages", tokens: 92_100 },
    ],
  },
};

/** Daemon replies used by components that fetch on mount. */
function demoRpc(method: string): unknown {
  switch (method) {
    case "project.config":
      return { default_agent: "claude", agents: {} };
    case "git.branches":
      return ["main", "develop", "release/1.4"];
    case "gh.issues":
    case "gh.prs":
      return [];
    case "fs.files":
      return ["src/components/Checkout.tsx", "src/styles/checkout.css", "README.md"];
    case "shell.history":
      return ["git status", "pnpm test", "pnpm dev"];
    case "shell.commands":
      return ["cd", "git", "ls", "pnpm"];
    default:
      return null;
  }
}

export interface PreviewState {
  /** Session to show as selected in the sidebar. */
  selected?: string | null;
  /** Chat to show for a chat terminal id (defaults to a demo conversation for id 1). */
  chats?: Record<number, Partial<ChatState>>;
}

/** Seeds moonlet's stores with demo data (idempotent). */
export function seedPreview({ selected = "s-checkout", chats = { 1: {} } }: PreviewState = {}) {
  setPreviewRpc(demoRpc);
  useStore.setState({
    hosts: { [DEMO_HOST]: host },
    projects: { [DEMO_HOST]: demoProjects },
    sessions: { [DEMO_HOST]: demoSessions },
    workspaces: { [DEMO_HOST]: [demoWorkspace] },
    sections: { [DEMO_HOST]: [demoSection] },
    terminals: { [DEMO_HOST]: Object.fromEntries(demoTerminals.map((x) => [x.id, x])) },
    git: demoGit,
    prs: demoPrs,
    unread: { [`${DEMO_HOST}:3`]: "blocked" },
    selected: selected ? { host: DEMO_HOST, session: selected } : null,
    showHistory: false,
    dialog: null,
    card: null,
    toasts: [],
  });
  useChat.setState({
    chats: Object.fromEntries(Object.entries(chats).map(([id, c]) => [chatKey(DEMO_HOST, Number(id)), { ...demoChat, ...c }])),
  });
}

/**
 * Wraps moonlet's app screens (Sidebar, AgentView, Composer) with demo data, so
 * they render without the daemon. Plain components (Button, ToolRow...) need
 * no wrapper.
 */
export function MoonletPreview({ children, ...state }: PreviewState & { children: ReactNode }) {
  // Seed once, before the children read the stores.
  useState(() => seedPreview(state));
  return <>{children}</>;
}
