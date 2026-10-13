// Test data shaped like the daemon's replies, named after the design board.

import type { PermissionAsk, Project, ReadRequest, Session, TerminalInfo, Workspace } from "@desktop/lib/protocol";
import { type ChatSummary, type HostData, emptyData } from "./app";

export const NOW = 1_760_000_000_000;
export const MIN = 60_000;

export const project = (id: string, name: string): Project => ({ id, name, path: `/src/${name}`, base_branch: "main" });

export const session = (id: string, name: string, patch: Partial<Session> = {}): Session => ({
  id,
  project_id: "storefront",
  name,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/wt/${id}`,
  agent: "claude",
  archived: false,
  created_at: NOW - 60 * MIN,
  workspace_id: "personal",
  terminals: [],
  layout: null,
  ...patch,
});

export const terminal = (id: number, sessionId: string, patch: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  kind: "agent",
  title: "Claude",
  cwd: "/wt",
  command: [],
  session_id: sessionId,
  agent: "claude",
  agent_state: "idle",
  cols: 80,
  rows: 24,
  pid: 1,
  created_at: NOW - 60 * MIN,
  last_output_at: NOW - MIN,
  chat: true,
  ...patch,
});

export const ask = (id: string, tool: string, patch: Partial<PermissionAsk> = {}): PermissionAsk => ({
  id,
  tool,
  summary: "",
  input: {},
  can_always: true,
  ...patch,
});

export const chat = (pending: PermissionAsk[], status: ChatSummary["status"] = pending.length ? "blocked" : "idle"): ChatSummary => ({
  pending,
  status,
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  slash_commands: [],
  queued: [],
});

export const read = (patch: Partial<ReadRequest> = {}): ReadRequest => ({
  request_id: 7,
  session_id: "fix-login",
  caller: 30,
  agent: "claude",
  terminal_id: 31,
  title: "zsh",
  command: "pnpm test",
  exit: 1,
  lines: 84,
  text: "FAIL",
  ...patch,
});

export const data = (patch: Partial<HostData>): HostData => ({ ...emptyData(), ...patch });

export const workspace = (id: string, name: string): Workspace => ({ id, name, color: "clay", section_ids: [], created_at: NOW });
