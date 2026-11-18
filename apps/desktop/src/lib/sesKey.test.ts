import { describe, expect, it } from "vitest";
import { parseSesKey, sesKey } from "./sesKey";

describe("sesKey (X106)", () => {
  it("parseSesKey reads back what sesKey wrote, for a copy host too", () => {
    expect(sesKey("local", "3f9a2c1d7e4b")).toBe("local/3f9a2c1d7e4b");
    expect(parseSesKey("local/3f9a2c1d7e4b")).toEqual({ host: "local", id: "3f9a2c1d7e4b" });
    // Another member's session through the central host's copy of it (X72).
    expect(parseSesKey("studio-mini#copy:8b1363261c6e/8b1363261c6e")).toEqual({ host: "studio-mini#copy:8b1363261c6e", id: "8b1363261c6e" });
  });
});
