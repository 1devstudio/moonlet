import { expect, it } from "vitest";
import { DEFAULT_SOUNDS, soundFor } from "./sounds";

it("uses the default sound per event", () => {
  expect(soundFor(undefined, "blocked")).toBe("Glass");
  expect(soundFor({}, "done")).toBe("Hero");
  expect(soundFor(DEFAULT_SOUNDS, "error")).toBe("Basso");
});

it("plays the chosen sound, nothing when off", () => {
  expect(soundFor({ done: "Ping" }, "done")).toBe("Ping");
  expect(soundFor({ blocked: "" }, "blocked")).toBeNull();
});

it("falls back to the default for unknown names and ignores other states", () => {
  expect(soundFor({ done: "../../etc/passwd" }, "done")).toBe("Hero");
  expect(soundFor(DEFAULT_SOUNDS, "working")).toBeNull();
  expect(soundFor(DEFAULT_SOUNDS, "idle")).toBeNull();
});
