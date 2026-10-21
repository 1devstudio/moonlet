import { describe, expect, it } from "vitest";
import { addHostReady, displayCode, readAddHostInput } from "./addHost";

describe("the Add host dialog's input (X57)", () => {
  it("takes the name, addresses and code from a pasted link", () => {
    expect(readAddHostInput("moonlet://pair?v=1&host=studio-mini&addr=100.101.102.103%3A47428&code=7KQ2MX9PDA")).toEqual({
      kind: "link",
      name: "studio-mini",
      addrs: ["100.101.102.103:47428"],
      code: "7KQ2MX9PDA",
    });
  });

  it("reads a code the way people type it", () => {
    for (const typed of ["7KQ2M-X9PDA", "7kq2m x9pda", " 7KQ2MX9PDA "]) {
      expect(readAddHostInput(typed)).toEqual({ kind: "code", code: "7KQ2MX9PDA" });
    }
    // O, I and L are read as 0 and 1, as the daemon does.
    expect(readAddHostInput("7KQ2M-X9PDO")).toEqual({ kind: "code", code: "7KQ2MX9PD0" });
  });

  it("says when it is neither", () => {
    for (const typed of ["hello", "7KQ2M-X9PD", "7KQ2M-X9PDU", "https://example.com"]) {
      expect(readAddHostInput(typed)).toEqual({ kind: "invalid", message: "This is not a pairing link or code." });
    }
    expect(readAddHostInput("  ")).toEqual({ kind: "empty" });
  });
});

describe("displayCode (X57)", () => {
  it("shows a code in two groups of five", () => {
    expect(displayCode("7KQ2MX9PDA")).toBe("7KQ2M-X9PDA");
    // A code from a daemon before X57 stays as it is.
    expect(displayCode("00112233445566778899aabbccddeeff")).toBe("00112233445566778899aabbccddeeff");
  });
});

describe("when Add host can pair (X57)", () => {
  it("needs a link, or a code with a name", () => {
    const link = "moonlet://pair?v=1&host=studio-mini&addr=100.101.102.103%3A47428&code=7KQ2MX9PDA";
    expect(addHostReady({ text: link, name: "" })).toBe(true);
    expect(addHostReady({ text: "7KQ2M-X9PDA", name: "" })).toBe(false);
    expect(addHostReady({ text: "7KQ2M-X9PDA", name: " studio-mini " })).toBe(true);
    expect(addHostReady({ text: "hello", name: "studio-mini" })).toBe(false);
    expect(addHostReady({ ssh: true, alias: " devbox " })).toBe(true);
    expect(addHostReady({ ssh: true, alias: "  " })).toBe(false);
  });
});
