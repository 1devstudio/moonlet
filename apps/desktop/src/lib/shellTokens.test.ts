import { describe, expect, it } from "vitest";
import { tokenize } from "./shellTokens";

/** Tokens as `kind:text`, without the whitespace between them. */
const kinds = (cmd: string) =>
  tokenize(cmd)
    .filter((t) => t.kind !== "space")
    .map((t) => `${t.kind}:${t.text}`);

describe("command line colouring (T8)", () => {
  it("labels a command, its subcommand and a flag", () => {
    expect(kinds("terraform init -upgrade")).toEqual(["command:terraform", "subcommand:init", "flag:-upgrade"]);
  });

  it("starts a new command after an operator", () => {
    expect(kinds('FOO=1 git commit -m "a b" && ls | wc -l')).toEqual([
      "env:FOO=1",
      "command:git",
      "subcommand:commit",
      "flag:-m",
      'string:"a b"',
      "operator:&&",
      "command:ls",
      "operator:|",
      "command:wc",
      "flag:-l",
    ]);
  });

  it("labels paths, and only the first bare word as a subcommand", () => {
    expect(kinds("cd ~/src")).toEqual(["command:cd", "path:~/src"]);
    expect(kinds("git log main")).toEqual(["command:git", "subcommand:log", "argument:main"]);
    expect(kinds("cat README.md")).toEqual(["command:cat", "argument:README.md"]);
  });

  it("does not take a redirection target for a command", () => {
    expect(kinds("echo hi > out.txt; date")).toEqual(["command:echo", "subcommand:hi", "operator:>", "argument:out.txt", "operator:;", "command:date"]);
  });

  it("takes &> and &>> for redirections, not command separators", () => {
    expect(kinds("echo hi &> out extra")).toEqual(["command:echo", "subcommand:hi", "operator:&>", "argument:out", "argument:extra"]);
    expect(kinds("make &>> build.log")).toEqual(["command:make", "operator:&>>", "argument:build.log"]);
  });

  it("runs an unclosed quote to the end", () => {
    expect(kinds("echo 'hi there")).toEqual(["command:echo", "string:'hi there"]);
  });

  it("keeps every character, whitespace included", () => {
    const cmd = "  git  status\n ls -la ";
    expect(tokenize(cmd).map((t) => t.text).join("")).toBe(cmd);
    expect(kinds(cmd)).toEqual(["command:git", "subcommand:status", "command:ls", "flag:-la"]);
  });
});
