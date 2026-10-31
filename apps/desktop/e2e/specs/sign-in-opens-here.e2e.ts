// Sign-ins open where you are (X75): a URL a terminal opens with $BROWSER
// reaches this Mac's app, which opens it and says who asked.

import { $, browser, expect } from "@wdio/globals";
import { rpc, world } from "../fixtures";

const w = world();
const URL = "https://example.test/signin";

type Opened = { __opened?: string[]; __moonletOpenUrl?: (u: string) => Promise<void> };

describe("sign-ins open where you are", () => {
  // The app's own opener stands in for the browser, so none opens.
  before(async () => {
    await browser.execute(() => {
      const win = window as unknown as Opened;
      win.__opened = [];
      win.__moonletOpenUrl = (u: string) => {
        win.__opened!.push(u);
        return Promise.resolve();
      };
    });
  });

  after(async () => {
    await browser.execute(() => {
      delete (window as unknown as Opened).__moonletOpenUrl;
    });
  });

  it("opens a terminal's $BROWSER URL with a toast naming who asked", async () => {
    rpc(w, "terminal.create", { cwd: "/tmp", command: ["sh", "-c", `"$BROWSER" ${URL}`] });
    await expect($('//*[contains(text(), "opened a sign-in")]')).toBeDisplayed();
    await browser.waitUntil(() => browser.execute((u: string) => ((window as unknown as Opened).__opened ?? []).includes(u), URL), {
      timeoutMsg: "the app never opened the URL",
    });
  });
});
