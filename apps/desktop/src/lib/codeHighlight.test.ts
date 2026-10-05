import { describe, expect, it } from "vitest";
import { diffRows, languageFor, readRows } from "./codeHighlight";

describe("languageFor", () => {
  it("picks the language from the extension or file name", () => {
    expect(languageFor("/repo/src/main.rs")).toBe("rust");
    expect(languageFor("apps/desktop/src/App.tsx")).toBe("typescript");
    expect(languageFor(".jaunt/config.toml")).toBe("ini");
    expect(languageFor("docs/README.MD")).toBe("markdown");
    expect(languageFor("/repo/Makefile")).toBe("makefile");
  });

  it("knows nothing of unknown or missing extensions", () => {
    expect(languageFor("notes.xyz")).toBeNull();
    expect(languageFor("/repo/LICENSE")).toBeNull();
    expect(languageFor("")).toBeNull();
  });
});

describe("readRows", () => {
  it("splits a Read's numbered lines into gutter numbers and coloured code", () => {
    // Claude Code's Read output, as saved in a chat.
    const output = '1\tfn main() {\n2\t    println!("hi");\n3\t}';
    expect(readRows(output, "/repo/src/main.rs")).toEqual([
      { n: 1, html: '<span class="hljs-keyword">fn</span> <span class="hljs-title function_">main</span>() {' },
      { n: 2, html: '    <span class="hljs-built_in">println!</span>(<span class="hljs-string">&quot;hi&quot;</span>);' },
      { n: 3, html: "}" },
    ]);
  });

  it("reads the older arrow format and escapes text of an unknown type", () => {
    expect(readRows('     9→<script>alert("x")</script>\n    10→a & b\n', "notes.xyz")).toEqual([
      { n: 9, html: "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;" },
      { n: 10, html: "a &amp; b" },
    ]);
  });

  it("escapes markup in a coloured file", () => {
    expect(readRows('1\tlet s = "<img src=x onerror=alert(1)>";', "a.rs")).toEqual([
      { n: 1, html: '<span class="hljs-keyword">let</span> <span class="hljs-variable">s</span> = <span class="hljs-string">&quot;&lt;img src=x onerror=alert(1)&gt;&quot;</span>;' },
    ]);
  });

  it("colours a comment on every line it spans", () => {
    expect(readRows("1\t/* one\n2\t   two */ let x;", "a.ts")).toEqual([
      { n: 1, html: '<span class="hljs-comment">/* one</span>' },
      { n: 2, html: '<span class="hljs-comment">   two */</span> <span class="hljs-keyword">let</span> x;' },
    ]);
  });

  it("leaves output that is not numbered lines to the plain view", () => {
    expect(readRows("<tool_use_error>File does not exist.</tool_use_error>", "/repo/a.rs")).toBeNull();
    expect(readRows("", "/repo/a.rs")).toBeNull();
  });
});

describe("diffRows", () => {
  it("colours an Edit's removed lines as the old file and added lines as the new one", () => {
    // The daemon's diff for an Edit that removes the start of a comment.
    const diff = "--- /repo/a.ts\n+++ /repo/a.ts\n@@\n-/* old\n+let x = 1;\n";
    expect(diffRows(diff)).toEqual([
      { kind: "hunk", html: "@@" },
      { kind: "del", html: '<span class="hljs-comment">/* old</span>' },
      { kind: "add", html: '<span class="hljs-keyword">let</span> x = <span class="hljs-number">1</span>;' },
    ]);
  });

  it("colours each file of a git diff by its own language", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 2338a13..c0c6440 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+let x;",
      "diff --git a/b.py b/b.py",
      "--- a/b.py",
      "+++ b/b.py",
      "@@ -1 +1 @@",
      "+def f(): pass",
    ].join("\n");
    expect(diffRows(diff)).toEqual([
      { kind: "hunk", html: "diff --git a/src/a.ts b/src/a.ts" },
      { kind: "hunk", html: "index 2338a13..c0c6440 100644" },
      { kind: "hunk", html: "@@ -1 +1 @@" },
      { kind: "add", html: '<span class="hljs-keyword">let</span> x;' },
      { kind: "hunk", html: "diff --git a/b.py b/b.py" },
      { kind: "hunk", html: "@@ -1 +1 @@" },
      { kind: "add", html: '<span class="hljs-keyword">def</span> <span class="hljs-title function_">f</span>(): <span class="hljs-keyword">pass</span>' },
    ]);
  });

  it("keeps a removed `-- ` line and an added `++ ` line inside a hunk", () => {
    // An Edit of notes.txt from "-- old note" to "++ new note".
    expect(diffRows("--- notes.txt\n+++ notes.txt\n@@\n--- old note\n+++ new note\n")).toEqual([
      { kind: "hunk", html: "@@" },
      { kind: "del", html: "-- old note" },
      { kind: "add", html: "++ new note" },
    ]);
  });

  it("colours a renamed file's removed lines by its old name and added lines by its new one", () => {
    expect(diffRows("--- a/f.py\n+++ b/f.rs\n@@\n-def f(): pass\n+fn f() {}\n")).toEqual([
      { kind: "hunk", html: "@@" },
      { kind: "del", html: '<span class="hljs-keyword">def</span> <span class="hljs-title function_">f</span>(): <span class="hljs-keyword">pass</span>' },
      { kind: "add", html: '<span class="hljs-keyword">fn</span> <span class="hljs-title function_">f</span>() {}' },
    ]);
  });

  it("colours a Write by its file and keeps git context lines", () => {
    expect(diffRows("--- /dev/null\n+++ notes.md\n@@\n+# Title\n")).toEqual([
      { kind: "hunk", html: "@@" },
      { kind: "add", html: '<span class="hljs-section"># Title</span>' },
    ]);
    expect(diffRows("--- a/x.py\n+++ /dev/null\n@@ -1,2 +0,0 @@ <b>\n-pass\n \n")).toEqual([
      { kind: "hunk", html: "@@ -1,2 +0,0 @@ &lt;b&gt;" },
      { kind: "del", html: '<span class="hljs-keyword">pass</span>' },
      { kind: "context", html: "" },
    ]);
  });
});
