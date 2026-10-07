import { describe, expect, it } from "vitest";
import { agentOptions, closeRequest, configName, fromForm, hasRunCommand, isDirty, loadFailure, toForm, validate, type Form } from "./projectSettings";

const form = (patch: Partial<Form> = {}): Form => ({ setup: "", run: "", archive: "", default_agent: "", base_branch: "", agents: [], ...patch });

describe("toForm and fromForm", () => {
  it("round-trips a config", () => {
    const c = { setup: "pnpm i", run: "pnpm dev", archive: null, default_agent: "yolo", base_branch: null, agents: { yolo: "claude --x" } };
    expect(fromForm(toForm(c))).toEqual(c);
  });

  it("turns blank fields into missing keys and trims the rest", () => {
    const c = fromForm(form({ run: "  ", setup: " pnpm i ", agents: [{ id: 1, name: " a ", cmd: " b " }] }));
    expect(c.run).toBeNull();
    expect(c.setup).toBe("pnpm i");
    expect(c.agents).toEqual({ a: "b" });
  });
});

describe("isDirty", () => {
  it("ignores whitespace-only edits", () => {
    expect(isDirty(form({ run: "x " }), form({ run: "x" }))).toBe(false);
    expect(isDirty(form({ run: "y" }), form({ run: "x" }))).toBe(true);
  });

  it("counts an added agent row", () => {
    expect(isDirty(form({ agents: [{ id: 1, name: "", cmd: "", fresh: true }] }), form())).toBe(true);
  });
});

describe("validate", () => {
  it("accepts a valid form", () => {
    expect(validate(form({ default_agent: "my.agent_2-x", agents: [{ id: 1, name: "my.agent_2-x", cmd: "aider" }] })).any).toBe(false);
    expect(validate(form({ default_agent: "codex" })).any).toBe(false);
  });

  it("flags names, commands and the default agent", () => {
    const v = validate(
      form({
        default_agent: "aider",
        agents: [
          { id: 1, name: "claude", cmd: "claude --model opus" },
          { id: 2, name: "my agent", cmd: "" },
          { id: 3, name: "x", cmd: "a" },
          { id: 4, name: "x", cmd: "b" },
        ],
      }),
    );
    expect(v.agents[1].name).toContain("built in");
    expect(v.agents[2].name).toContain("letters");
    expect(v.agents[2].cmd).toBe("Enter a command.");
    expect(v.agents[3]).toBeUndefined();
    expect(v.agents[4].name).toContain("already called x");
    expect(v.defaultAgent).toBe("aider is not an agent in this project.");
  });

  it("does not flag an untouched new row but blocks saving it", () => {
    const v = validate(form({ agents: [{ id: 1, name: "", cmd: "", fresh: true }] }));
    expect(v.agents[1]).toEqual({});
    expect(v.any).toBe(true);
  });
});

describe("agentOptions", () => {
  it("lists none, the built-ins, valid custom names and an invalid current value", () => {
    const opts = agentOptions(form({ default_agent: "gone", agents: [{ id: 1, name: "yolo", cmd: "x" }, { id: 2, name: "bad name", cmd: "y" }] }));
    expect(opts.map((o) => o.value)).toEqual(["", "claude", "codex", "yolo", "gone"]);
  });
});

describe("hasRunCommand", () => {
  it("is false for a missing, empty or blank run command, so Run opens Project settings", () => {
    expect(hasRunCommand(null)).toBe(false);
    expect(hasRunCommand({ agents: {} })).toBe(false);
    expect(hasRunCommand({ run: "  ", agents: {} })).toBe(false);
    expect(hasRunCommand({ run: "pnpm dev", agents: {} })).toBe(true);
  });
});

describe("loadFailure", () => {
  it("closes the dialog when the first load fails", () => {
    expect(loadFailure(false, "no such project")).toEqual({ close: true });
  });

  it("keeps the dialog open with the error and Reload when a reload fails", () => {
    expect(loadFailure(true, "connection lost")).toEqual({
      close: false,
      saveErr: { message: "Could not reload .moonlet/config.toml: connection lost", stale: true },
    });
  });
});

describe("closeRequest", () => {
  it("closes at once when nothing changed or the file did not parse", () => {
    expect(closeRequest({ saving: false, parseError: false, dirty: false })).toBe("close");
    expect(closeRequest({ saving: false, parseError: true, dirty: true })).toBe("close");
  });

  it("asks before discarding unsaved changes", () => {
    expect(closeRequest({ saving: false, parseError: false, dirty: true })).toBe("ask");
  });

  it("waits while a save is running, which closes the dialog itself", () => {
    expect(closeRequest({ saving: true, parseError: false, dirty: true })).toBe("wait");
  });
});

describe("configName", () => {
  it("names the file the dialog edits, jaunt's while only that one exists (X27)", () => {
    expect(configName("/Users/me/web/.moonlet/config.toml")).toBe(".moonlet/config.toml");
    expect(configName("/Users/me/web/.jaunt/config.toml")).toBe(".jaunt/config.toml");
    expect(configName(undefined)).toBe(".moonlet/config.toml");
  });
});
