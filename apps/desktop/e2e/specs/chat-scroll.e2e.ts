// A chat's transcript scrolls in its pane (X94): the design's padding, a fade
// on each edge with more to show, and Latest once the end is far away. A fake
// `claude` answers with a long reply.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { PROJECT, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Scroll the long answer";
const LINES = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the long answer.`);
const LAST = LINES[LINES.length - 1];

/** An init, then for any message one long answer. printf, because /bin/sh's echo expands the \n in the JSON. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-x94","model":"e2e-model","slash_commands":[]}' ;;
    *'"type":"user"'*)
      out '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"${LINES.join("\\n\\n")}"}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":2}}' ;;
  esac
done
`;

const content = "//div[@data-transcript]";
const scroller = `${content}/..`;
const fade = (edge: string) => $(`${scroller}/../span[@data-fade="${edge}"]`);
const latest = () => $(`${scroller}/../button[normalize-space()="Latest"]`);

/** The transcript's scroll position, as its edges see it. */
const left = () =>
  browser.execute((x: string) => {
    const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
    return el.scrollHeight - el.clientHeight - el.scrollTop;
  }, scroller) as Promise<number>;

describe("a chat's transcript in its pane (X94)", () => {
  let blocked = "";
  let sessionId = "";

  before(async () => {
    blocked = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, FAKE_CLAUDE);
    chmodSync(FAKE, 0o755);
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    sessionId = rpc<{ id: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude", prompt: "Answer at length." }).id;
    await browser.waitUntil(
      () => {
        const chat = rpc<{ id: number; chat: boolean; session_id?: string }[]>(w, "terminal.list", {}).find((t) => t.chat && t.session_id === sessionId);
        const st = chat && rpc<{ items: { text: string }[] }>(w, "chat.state", { id: chat.id });
        return !!st?.items.some((i) => i.text.includes(LAST));
      },
      { timeout: 30_000, timeoutMsg: "the chat never answered" },
    );
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const tab = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        return $(sel.text(LAST)).isDisplayed();
      },
      { timeout: 30_000, timeoutMsg: "the long answer never showed" },
    );
  });

  after(() => {
    rpc(w, "session.archive", { id: sessionId });
    writeFileSync(FAKE, blocked);
  });

  it("pads the transcript 24 px above and below and 28 at the sides, as wide as its pane, and the composer 4 above, 14 below and 16 at the sides", async () => {
    // A window wide enough that the chat's pane is wider than the old 880 px cap.
    const before = await browser.getWindowSize();
    await browser.setWindowSize(1900, before.height);
    try {
      const measure = () =>
        browser.execute((x: string) => {
          const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
          const c = getComputedStyle(el);
          return {
            pad: { top: c.paddingTop, bottom: c.paddingBottom, left: c.paddingLeft, right: c.paddingRight },
            width: el.offsetWidth,
            pane: (el.parentElement as HTMLElement).clientWidth,
          };
        }, content);
      await browser.waitUntil(async () => (await measure()).pane > 1000, { timeoutMsg: "the chat's pane never widened past 1000 px" });
      const t = await measure();
      expect(t.pad).toEqual({ top: "24px", bottom: "24px", left: "28px", right: "28px" });
      // No fixed width: the transcript fills its pane.
      expect(t.width).toBe(t.pane);
    } finally {
      await browser.setWindowSize(before.width, before.height);
    }
    // The composer: 4 px above, 14 below, 16 at the sides.
    const composer = await browser.execute(() => {
      const c = getComputedStyle(document.querySelector('section[aria-label="Chat input"]') as HTMLElement);
      return { top: c.paddingTop, bottom: c.paddingBottom, left: c.paddingLeft, right: c.paddingRight };
    });
    expect(composer).toEqual({ top: "4px", bottom: "14px", left: "16px", right: "16px" });
  });

  it("fades only the top at the end, keeps the overscroll in, and offers no Latest", async () => {
    await browser.waitUntil(async () => (await left()) <= 1, { timeoutMsg: "the chat did not open at its end" });
    await expect(fade("top")).toBeExisting();
    await expect(fade("bottom")).not.toBeExisting();
    await expect(latest()).not.toBeExisting();
    expect(await browser.execute((x: string) => getComputedStyle(document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement).overscrollBehaviorY, scroller)).toBe("contain");
  });

  it("offers Latest once scrolled far from the end, which goes back to it", async () => {
    await browser.execute((x: string) => {
      (document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement).scrollTop = 0;
    }, scroller);
    await expect(latest()).toBeDisplayed({ wait: 5_000 });
    await expect(fade("bottom")).toBeExisting();
    await expect(fade("top")).not.toBeExisting();
    await latest().click();
    await browser.waitUntil(async () => (await left()) <= 1, { timeout: 10_000, timeoutMsg: "Latest never reached the end" });
    await expect(latest()).not.toBeExisting({ wait: 5_000 });
  });
});
