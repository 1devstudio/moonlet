import { describe, expect, it } from "vitest";
import { callbackForward, isWebPage, pagesToOpen } from "./oauthRedirect";
import type { McpServer } from "./protocol";

// Sign-in pages captured from Claude Code 2.1.292 and codex-cli 0.160.0.
const CLAUDE_LINEAR =
  "https://mcp.linear.app/authorize?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclaude-code-client-metadata&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A59910%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";
const CODEX_LINEAR =
  "https://mcp.linear.app/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fcodex%2Fclient.json&state=S&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A51137%2Fcallback&scope=read+write+openid+email&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";
const CLAUDE_AI = "https://claude.ai/api/organizations/00000000-0000-4000-8000-000000000000/mcp/start-auth/mcpsrv_01X9Cj9u4wAJRmUBaoFV4yFt?product_surface=sdk-cli";

describe("sign-in callbacks on a remote host (X29)", () => {
  it("finds the loopback port the browser returns to", () => {
    expect(callbackForward(CLAUDE_LINEAR)).toEqual({ bind: "localhost", port: 59910 });
    expect(callbackForward(CODEX_LINEAR)).toEqual({ bind: "127.0.0.1", port: 51137 });
  });

  it("forwards nothing for a sign-in that finishes on a website", () => {
    expect(callbackForward(CLAUDE_AI)).toBeNull();
    expect(callbackForward("https://idp.example/authorize?redirect_uri=https%3A%2F%2Fapp.example%2Fcb")).toBeNull();
    expect(callbackForward("not a url")).toBeNull();
  });
});

describe("opening sign-in pages (X29)", () => {
  const server = (name: string, status: string, auth_url?: string): McpServer => ({ name, status, transport: "http", tools: [], auth_url });

  it("opens the page of a server the user asked to sign in, once", () => {
    const asked = new Set(["linear"]);
    const servers = [server("linear", "authing", CLAUDE_LINEAR), server("sentry", "authing"), server("slack", "connected")];
    expect(pagesToOpen(servers, asked)).toEqual([{ name: "linear", url: CLAUDE_LINEAR }]);
    expect(pagesToOpen(servers, asked)).toEqual([]);
  });

  it("opens nothing for a sign-in started elsewhere, such as another window", () => {
    expect(pagesToOpen([server("linear", "authing", CLAUDE_LINEAR)], new Set())).toEqual([]);
  });

  it("keeps waiting until the page arrives", () => {
    const asked = new Set(["linear"]);
    expect(pagesToOpen([server("linear", "authing")], asked)).toEqual([]);
    expect(pagesToOpen([server("linear", "authing", CODEX_LINEAR)], asked)).toEqual([{ name: "linear", url: CODEX_LINEAR }]);
  });

  it("never opens anything but a web page", () => {
    expect(pagesToOpen([server("x", "authing", "file:///etc/passwd"), server("y", "authing", "javascript:alert(1)")], new Set(["x", "y"]))).toEqual([]);
  });
});

describe("which sign-in pages may open (X29)", () => {
  it("accepts web pages only", () => {
    expect(isWebPage(CLAUDE_AI)).toBe(true);
    expect(isWebPage("HTTP://example.test/x")).toBe(true);
    expect(isWebPage("file:///etc/passwd")).toBe(false);
    expect(isWebPage("javascript:alert(1)")).toBe(false);
    expect(isWebPage("vscode://open?x")).toBe(false);
  });
});
