// Settings › Phones (X39, X43): allow phones, pair one with the code from the QR
// link, see it in the list, and remove it. The "phone" is a TCP client here,
// speaking the daemon's framing.

import { connect } from "node:net";
import { $, browser, expect } from "@wdio/globals";
import { closeSettings, jsonFrame, openSettings, sel } from "../fixtures";

const allow = sel.settingsSwitch("Allow connections from my tailnet");
const allowed = async () => (await $(allow).getAttribute("aria-checked")) === "true";

/** One `auth` frame, `[u32 len][u8 kind 1][json]`, and the daemon's first reply. */
function phoneAuth(addr: string, fields: object): Promise<{ t: string; token?: string }> {
  const [host, port] = [addr.slice(0, addr.lastIndexOf(":")), Number(addr.slice(addr.lastIndexOf(":") + 1))];
  return new Promise((resolve, reject) => {
    const sock = connect(port, host, () => sock.write(jsonFrame({ t: "auth", ...fields })));
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        resolve(JSON.parse(buf.subarray(5, 4 + buf.readUInt32BE(0)).toString()));
        sock.destroy();
      }
    });
    sock.on("error", reject);
  });
}

describe("mobile pairing", () => {
  before(async () => {
    await openSettings("Phones");
  });

  // Phone access is the daemon's setting, kept for the rest of the run:
  // turn it off again. (The CLI's `moonlet rpc` may not manage phones.)
  after(async () => {
    if (await allowed()) await $(allow).click();
    await closeSettings();
  });

  it("listens once phones are allowed", async () => {
    await expect($(sel.text("Off"))).toBeDisplayed();
    await expect($(sel.button("Pair a phone"))).toBeDisabled();
    await $(allow).click();
    await browser
      .waitUntil(async () => (await $('//*[starts-with(normalize-space(), "Listening on 127.0.0.1:")]').isExisting()), { timeout: 15000 })
      .catch(async () => {
        const text = await browser.execute(() => document.evaluate('//*[@aria-label="Settings"]//main', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue?.textContent);
        throw new Error(`the page never said it was listening: ${text}`);
      });
    await expect($(sel.button("Pair a phone"))).toBeEnabled();
  });

  it("pairs a phone with the code from the link and lists it", async () => {
    await $(sel.button("Pair a phone")).click();
    await expect($('svg[aria-label="Pairing QR code"]')).toBeDisplayed();
    const link = await $('//code[starts-with(normalize-space(), "moonlet://pair?v=1&")]').getText();
    const url = new URL(link);
    expect(await $('//*[starts-with(normalize-space(), "Expires in ")]').isDisplayed()).toBe(true);

    const reply = await phoneAuth(url.searchParams.get("addr")!, { pair: url.searchParams.get("code"), device: "e2e phone" });
    expect(reply.t).toBe("authed");
    expect(reply.token).toHaveLength(64);

    await expect($(sel.text("Paired with e2e phone"))).toBeDisplayed();
    await expect($('svg[aria-label="Pairing QR code"]')).not.toBeExisting();
    await expect($(sel.text("e2e phone"))).toBeDisplayed();
  });

  it("removes a phone after asking", async () => {
    await $('//div[span/span[normalize-space()="e2e phone"]]/button[normalize-space()="Remove"]').click();
    await expect($(sel.confirm("Remove e2e phone?"))).toBeDisplayed();
    await $(sel.confirmButton("Remove")).click();
    await expect($(sel.text("e2e phone"))).not.toBeExisting();
    await expect($(sel.text("Paired phones"))).not.toBeExisting();
  });
});
