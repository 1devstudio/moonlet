import { afterEach, describe, expect, it } from "vitest";
import { promptHistory, rememberPrompt } from "./chat";
import { readStored } from "./storage";

afterEach(() => localStorage.clear());

describe("readStored", () => {
  it("reads moonlet's key, then the one jaunt wrote (X27)", () => {
    localStorage.setItem("jaunt.settings", '{"editorTheme":"light-plus"}');
    expect(readStored("settings")).toBe('{"editorTheme":"light-plus"}');
    localStorage.setItem("moonlet.settings", '{"editorTheme":"dark-plus"}');
    expect(readStored("settings")).toBe('{"editorTheme":"dark-plus"}');
    expect(readStored("ui")).toBeNull();
  });
});

describe("prompt history", () => {
  it("keeps the prompts jaunt remembered and saves under moonlet's key", () => {
    localStorage.setItem("jaunt.prompts", '["fix the build"]');
    expect(promptHistory()).toEqual(["fix the build"]);
    rememberPrompt("add tests");
    expect(JSON.parse(localStorage.getItem("moonlet.prompts") ?? "null")).toEqual(["fix the build", "add tests"]);
  });
});
