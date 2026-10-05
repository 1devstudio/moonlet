import { describe, expect, it } from "vitest";
import { outputView, toolOutputView } from "./toolOutput";

// Outputs below are captured from Bash calls in saved agent chats.

describe("outputView", () => {
  it("shows a unified diff in the diff view", () => {
    const gitDiff = [
      "diff --git a/apps/desktop/src/lib/chat.ts b/apps/desktop/src/lib/chat.ts",
      "index 2338a13..c0c6440 100644",
      "--- a/apps/desktop/src/lib/chat.ts",
      "+++ b/apps/desktop/src/lib/chat.ts",
      '@@ -275,6 +275,15 @@ export function toolGroupStatus(tools: readonly ChatItem[]): ToolCall["status"]',
      " /** Thinking squeezed onto one line for its collapsed row. */",
      "+/** The whole command of a shell call, for its opened row. */",
    ].join("\n");
    expect(outputView(gitDiff)).toEqual({ kind: "diff", diff: gitDiff });
    const plainDiff = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n";
    expect(outputView(plainDiff)).toEqual({ kind: "diff", diff: plainDiff });
  });

  it("highlights JSON", () => {
    // gh pr merge … --json mergedAt,state
    expect(outputView('{"state":"MERGED","n":2}\n')).toEqual({
      kind: "code",
      html: [
        '<span class="hljs-punctuation">{</span><span class="hljs-attr">&quot;state&quot;</span><span class="hljs-punctuation">:</span><span class="hljs-string">&quot;MERGED&quot;</span><span class="hljs-punctuation">,</span><span class="hljs-attr">&quot;n&quot;</span><span class="hljs-punctuation">:</span><span class="hljs-number">2</span><span class="hljs-punctuation">}</span>',
      ],
    });
    expect(outputView('[\n  true\n]')).toEqual({ kind: "code", html: ['<span class="hljs-punctuation">[</span>', '  <span class="hljs-literal"><span class="hljs-keyword">true</span></span>', '<span class="hljs-punctuation">]</span>'] });
  });

  it("colours a diffstat's plus and minus runs and dims its summary", () => {
    const stat = [
      "commit 7ae4073906b256653aa7aece0be87f1dd9637bd5",
      " apps/desktop/src/components/AgentView.tsx | 18 ++++++++++++++----",
      " apps/desktop/src/lib/chat.ts              |  9 +++++++++",
      " 4 files changed, 45 insertions(+), 5 deletions(-)",
    ].join("\n");
    expect(outputView(stat)).toEqual({
      kind: "lines",
      lines: [
        [{ text: "commit 7ae4073906b256653aa7aece0be87f1dd9637bd5" }],
        [{ text: " apps/desktop/src/components/AgentView.tsx " }, { text: "|", tone: "dim" }, { text: " 18 " }, { text: "++++++++++++++", tone: "add" }, { text: "----", tone: "del" }],
        [{ text: " apps/desktop/src/lib/chat.ts              " }, { text: "|", tone: "dim" }, { text: "  9 " }, { text: "+++++++++", tone: "add" }],
        [{ text: " 4 files changed, 45 insertions(+), 5 deletions(-)", tone: "dim" }],
      ],
    });
  });

  it("dims the location at the start of grep and compiler lines", () => {
    const grep = [
      "tools/deploy/src/orchestrate.ts:174:    throw new Error(`build/deploy task(s)`);",
      "src/main.rs:12:5: unused variable",
      '4:import { run } from "./orchestrate.js";',
      "https://example.com:8080/x",
    ].join("\n");
    expect(outputView(grep)).toEqual({
      kind: "lines",
      lines: [
        [{ text: "tools/deploy/src/orchestrate.ts:174:", tone: "dim" }, { text: "    throw new Error(`build/deploy task(s)`);" }],
        [{ text: "src/main.rs:12:5:", tone: "dim" }, { text: " unused variable" }],
        [{ text: "4:", tone: "dim" }, { text: 'import { run } from "./orchestrate.js";' }],
        [{ text: "https://example.com:8080/x" }],
      ],
    });
  });

  it("colours status words, but not zero counts or parts of names", () => {
    const tests = [
      "test result: ok. 129 passed; 0 failed; 0 ignored",
      " FAIL  src/lib/codeHighlight.test.ts > readRows",
      "     × splits a Read's numbered lines 2ms",
      "TypeError: readRows is not a function",
      "warning: unused variable: `x`",
      "     ✓ src/lib/chat.test.ts (40 tests) 21ms",
      "error[E0425]: cannot find value `errorToast` in this scope",
      "tools/deploy/src/sdk.ts:352:    throw new Error(`npm view versions failed (exit ${res.code})`);",
    ].join("\n");
    expect(outputView(tests)).toEqual({
      kind: "lines",
      lines: [
        [{ text: "test result: " }, { text: "ok", tone: "ok" }, { text: ". 129 " }, { text: "passed", tone: "ok" }, { text: "; 0 failed; 0 ignored" }],
        [{ text: " " }, { text: "FAIL", tone: "error" }, { text: "  src/lib/codeHighlight.test.ts > readRows" }],
        [{ text: "     " }, { text: "×", tone: "error" }, { text: " splits a Read's numbered lines 2ms" }],
        [{ text: "TypeError: readRows is not a function" }],
        [{ text: "warning", tone: "warn" }, { text: ": unused variable: `x`" }],
        [{ text: "     " }, { text: "✓", tone: "ok" }, { text: " src/lib/chat.test.ts (40 tests) 21ms" }],
        [{ text: "error", tone: "error" }, { text: "[E0425]: cannot find value `errorToast` in this scope" }],
        [{ text: "tools/deploy/src/sdk.ts:352:", tone: "dim" }, { text: "    throw new Error(`npm view versions " }, { text: "failed", tone: "error" }, { text: " (exit ${res.code})`);" }],
      ],
    });
  });

  it("leaves output without any of these shapes plain", () => {
    expect(outputView("[evolve] Uploading tarball of [.]\n45000 bytes written to file /tmp/x17.png\n")).toBeNull();
    expect(outputView("")).toBeNull();
  });
});

describe("toolOutputView", () => {
  const tool = (name: string, input: unknown, output: string, summary = "") => ({ name, summary, input, output, status: "ok" as const });

  it("colours a Read by the file path in its input, not the summary the daemon cuts to 200 characters", () => {
    const path = `/repo/${"deep/".repeat(40)}main.rs`;
    expect(toolOutputView(tool("Read", { file_path: path }, "1\tfn main() {}", path.slice(0, 200)))).toEqual({
      kind: "read",
      rows: [{ n: 1, html: '<span class="hljs-keyword">fn</span> <span class="hljs-title function_">main</span>() {}' }],
    });
  });

  it("colours shell and Grep output, even a shell call whose input has no command", () => {
    const diff = "--- a.txt\n+++ a.txt\n@@\n-a\n+b\n";
    expect(toolOutputView(tool("Bash", {}, diff))).toEqual({ kind: "diff", diff });
    expect(toolOutputView(tool("shell", { command: ["git", "diff"] }, diff))).toEqual({ kind: "diff", diff });
    expect(toolOutputView(tool("Grep", { pattern: "x" }, "4:x", '"x"'))).toEqual({ kind: "lines", lines: [[{ text: "4:", tone: "dim" }, { text: "x" }]] });
  });

  it("leaves other tools' output plain", () => {
    expect(toolOutputView(tool("WebFetch", { url: "https://example.com" }, "Build failed: see log"))).toBeNull();
    expect(toolOutputView(tool("Read", { file_path: "/repo/a.rs" }, "<tool_use_error>File does not exist.</tool_use_error>"))).toBeNull();
  });
});
