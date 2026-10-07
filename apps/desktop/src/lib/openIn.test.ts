import { describe, expect, it } from "vitest";
import { openInChoices } from "./openIn";

// What `open_targets` returns on a Mac with Cursor, Zed, Ghostty and Terminal installed.
const targets = [
  { id: "finder", label: "Finder" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "ghostty", label: "Ghostty" },
  { id: "terminal", label: "Terminal" },
];

describe("openInChoices (X25)", () => {
  it("reveals a local file in Finder and offers the editors, not the terminals", () => {
    expect(openInChoices(targets, { dir: false, remote: false })).toEqual([
      { id: "reveal", label: "Finder" },
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ]);
  });

  it("opens a local folder in Finder, the editors and the terminals", () => {
    expect(openInChoices(targets, { dir: true, remote: false })).toEqual(targets);
  });

  it("offers only VS Code and Cursor on a remote host", () => {
    const withVsCode = [...targets, { id: "vscode", label: "VS Code" }];
    const remote = [
      { id: "cursor", label: "Cursor" },
      { id: "vscode", label: "VS Code" },
    ];
    expect(openInChoices(withVsCode, { dir: false, remote: true })).toEqual(remote);
    expect(openInChoices(withVsCode, { dir: true, remote: true })).toEqual(remote);
  });
});
