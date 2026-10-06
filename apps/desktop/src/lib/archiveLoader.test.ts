import { describe, expect, it } from "vitest";
import { pickLoader } from "./archiveLoader";

describe("pickLoader", () => {
  it("maps a random number to one of the five scenes, each equally likely", () => {
    expect(pickLoader(() => 0)).toBe("Gravedigger");
    expect(pickLoader(() => 0.2)).toBe("Ghost");
    expect(pickLoader(() => 0.5)).toBe("Zombie wave");
    expect(pickLoader(() => 0.7)).toBe("Graveyard progress");
    expect(pickLoader(() => 0.99)).toBe("Reaper");
  });
});
