import { describe, expect, it } from "vitest";
import { DESKTOP_THEME } from "./terminalTheme";

describe("terminal colours (X94)", () => {
  it("draws the desktop's terminals on the content's tone, #121212, so a terminal fills its pane", () => {
    expect(DESKTOP_THEME.background.toLowerCase()).toBe("#121212");
    expect(DESKTOP_THEME.cursorAccent.toLowerCase()).toBe("#121212");
  });
});
