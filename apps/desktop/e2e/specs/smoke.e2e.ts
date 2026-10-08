import { $, browser, expect } from "@wdio/globals";
import { PROJECT, SESSION, sel } from "../fixtures";

describe("app start", () => {
  it("connects to the scratch daemon and lists the seeded project and session", async () => {
    await expect($(sel.text(PROJECT))).toBeDisplayed({ wait: 30_000 });
    await expect($(sel.sessionRow(SESSION))).toBeDisplayed();
    await expect(browser).toHaveTitle("moonlet");
  });
});
