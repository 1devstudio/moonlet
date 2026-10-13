// Settings › Mobile (X39): allow phones, pair one with the code from the QR
// link, see it in the list, and remove it. The "phone" is a TCP client here,
// speaking the daemon's framing.

import { connect } from "node:net";
import { $, browser, expect } from "@wdio/globals";
import { sel } from "../fixtures";

const allow = '//label[normalize-space()="Allow phones on my tailnet"]/input';

/** One `auth` frame, `[u32 len][u8 kind 1][json]`, and the daemon's first reply. */
function phoneAuth(addr: string, fields: object): Promise<{ t: string; token?: string }> {
  const [host, port] = [addr.slice(0, addr.lastIndexOf(":")), Number(addr.slice(addr.lastIndexOf(":") + 1))];
  return new Promise((resolve, reject) => {
    const sock = connect(port, host, () => {
      const json = Buffer.from(JSON.stringify({ t: "auth", ...fields }));
      const head = Buffer.alloc(5);
      head.writeUInt32BE(json.length + 1, 0);
      head.writeUInt8(1, 4);
      sock.write(Buffer.concat([head, json]));
    });
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
    await $('button[title="Settings (⌘,)"]').click();
    await expect($('[role="dialog"][aria-label="Settings"]')).toBeDisplayed();
  });

  // Phone access is the daemon's setting, kept for the rest of the run:
  // turn it off again. (The CLI's `moonlet rpc` may not manage phones.)
  after(async () => {
    if (await $(allow).isSelected()) await $(allow).click();
    await $('[role="dialog"][aria-label="Settings"] button[title="Close"]').click();
  });

  it("listens once phones are allowed", async () => {
    await expect($(sel.text("Off"))).toBeDisplayed();
    await expect($(sel.button("Pair a phone"))).toBeDisabled();
    await $(allow).click();
    await browser
      .waitUntil(async () => (await $('//*[starts-with(normalize-space(), "Listening on 127.0.0.1:")]').isExisting()), { timeout: 15000 })
      .catch(async () => {
        const text = await browser.execute(() => document.evaluate('//section[h3[normalize-space()="Mobile"]]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue?.textContent);
        throw new Error(`the section never said it was listening: ${text}`);
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
    await $('//li[.//span[normalize-space()="e2e phone"]]//button[normalize-space()="Remove"]').click();
    await expect($(sel.confirm("Remove e2e phone?"))).toBeDisplayed();
    await $(sel.confirmButton("Remove")).click();
    await expect($(sel.text("e2e phone"))).not.toBeExisting();
    await expect($(sel.text("Paired phones"))).not.toBeExisting();
  });
});
