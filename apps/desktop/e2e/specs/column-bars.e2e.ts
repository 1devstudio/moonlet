// Column bars and panes (X94): a 44 px header row and a 36 px tab row in every
// column on the window's tone, content in rounded panes with no lines, the
// session's name in its header, session tabs that scroll with fades and an All
// tabs list, and the right panel's views in More when they don't fit.

import { $, $$, browser, expect } from "@wdio/globals";
import { SESSION, closeSettings, fill, openSettings, projectId, rpc, sel, world } from "../fixtures";

const w = world();
const MANY = "Many tabs";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where an element is in the window. */
const box = (xpath: string) =>
  browser.execute((x: string) => {
    const e = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement | null;
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }, xpath) as Promise<Box | null>;

const sidebarHeader = '//aside[.//button[starts-with(normalize-space(), "New session")]]/div[1]';
const sessionHeader = '//header[@aria-label="Session"]';
const rightHeader = '//button[normalize-space()="Run"]/parent::div';
const tabRow = '//div[@role="tablist"][@aria-label="Session tabs"]/parent::div/parent::div';
const viewRow = '//div[@id="right-tabpanel"]/../preceding-sibling::div[1]';
const scrollLeft = 'button[aria-label="Scroll tabs left"]';
const scrollRight = 'button[aria-label="Scroll tabs right"]';
const allTabs = 'button[aria-label="All tabs"]';

/** An element's computed style, by property. */
const style = (xpath: string, props: string[]) =>
  browser.execute(
    (x: string, ps: string[]) => {
      const e = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      const c = getComputedStyle(e);
      return Object.fromEntries(ps.map((p) => [p, c.getPropertyValue(p)]));
    },
    xpath,
    props,
  ) as Promise<Record<string, string>>;

// The tones: the window #191919, the sidebar's; a pane #121212, the content's; a control #1F1F1F.
const WINDOW = "rgb(25, 25, 25)";
const PANE = "rgb(18, 18, 18)";
const CONTROL = "rgb(31, 31, 31)";
const sessionPane = `${tabRow}/following-sibling::div[1]`;
const rightPane = '//div[@id="right-tabpanel"]';
const shownTab = '//div[@role="tab"][@aria-selected="true"]';

/** The right panel's ⋯ menu: Toggle sidebar ⌘B. */
async function toggleSidebar() {
  await $('button[title="More"]').click();
  await $(sel.button("Toggle sidebar")).click();
}

async function setFontSize(size: string) {
  await openSettings("Appearance");
  await fill(sel.settingsField("Font size"), size);
  await closeSettings();
}

describe("column bars (X94)", () => {
  let many = "";

  before(async () => {
    // The sidebar's state outlives a run (localStorage): start with it open.
    const closed = await browser.execute(() => {
      const ui = JSON.parse(localStorage.getItem("moonlet.ui") ?? "{}");
      if (ui.sidebarOpen !== false) return false;
      localStorage.setItem("moonlet.ui", JSON.stringify({ ...ui, sidebarOpen: true }));
      return true;
    });
    if (closed) await browser.refresh();
    // A window in the background holds CSS transitions: a row's fill would stay half faded in.
    await browser.execute(() => {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { transition: none !important; }";
      document.head.appendChild(style);
    });
    await $(sel.sessionRow(SESSION)).click();
    await expect($(sessionHeader)).toBeDisplayed({ wait: 10_000 });
    // The font size outlives a run too: start at the default.
    await setFontSize("13");
  });

  after(async () => {
    if (many) rpc(w, "session.archive", { id: many });
    await setFontSize("13");
  });

  it("lines up a 44 px header row in the sidebar, the session and the right panel, with the 36 px tab rows under it", async () => {
    for (const x of [sidebarHeader, sessionHeader, rightHeader]) {
      expect(await box(x)).toMatchObject({ top: 0, height: 44 });
    }
    for (const x of [tabRow, viewRow]) {
      expect(await box(x)).toMatchObject({ top: 44, height: 36 });
    }
    // Two tabs at their full 184 px, 2 px apart.
    const tabs = (await browser.execute(() => [...document.querySelectorAll("[data-tab]")].map((t) => t.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, width: r.width })))) as {
      left: number;
      right: number;
      width: number;
    }[];
    expect(tabs.map((t) => t.width)).toEqual([184, 184]);
    expect(tabs[1].left - tabs[0].right).toBe(2);
  });

  it("draws no lines: the bars sit on the window's tone, what a column shows in a rounded pane 6 px from the next", async () => {
    expect(await style("//body", ["background-color"])).toEqual({ "background-color": WINDOW });
    for (const x of [sidebarHeader, sessionHeader, rightHeader, tabRow, viewRow]) {
      expect(await style(x, ["border-bottom-width"])).toEqual({ "border-bottom-width": "0px" });
    }
    for (const x of [sessionPane, rightPane]) {
      expect(await style(x, ["background-color", "border-top-left-radius"])).toEqual({ "background-color": PANE, "border-top-left-radius": "10px" });
    }
    const left = (await box(sessionPane))!;
    const right = (await box(rightPane))!;
    expect(right.left - (left.left + left.width)).toBe(6);
    expect(left.top).toBe(80);
    // The column separators draw no line.
    const separators = await browser.execute(() =>
      [...document.querySelectorAll('[role="separator"][aria-orientation="vertical"]')].map((e) => getComputedStyle(e).backgroundColor),
    );
    expect(separators).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  });

  it("fills the tab shown and the terminal with the pane's tone, so they join the pane", async () => {
    expect(await style(shownTab, ["background-color", "height", "border-top-left-radius"])).toEqual({ "background-color": PANE, height: "32px", "border-top-left-radius": "8px" });
    expect((await box(shownTab))!.top).toBe(48);
    // Around the terminal, the pane's tone; the terminal draws its own in it (terminalTheme.test.ts).
    await browser.waitUntil(async () => (await $$(".moonlet-term").length) > 0, { timeoutMsg: "no terminal drew" });
    expect(await style("(//div[@data-terminal-pane])[1]", ["background-color"])).toEqual({ "background-color": PANE });
  });

  it("fills the header's controls instead of outlining them, and the session shown in the sidebar", async () => {
    expect(await style('//button[normalize-space()="Run"]', ["background-color", "border-top-width"])).toEqual({ "background-color": CONTROL, "border-top-width": "0px" });
    // Once its fill has faded in.
    await browser.waitUntil(async () => (await style(sel.sessionRow(SESSION), ["background-color"]))["background-color"] === PANE, {
      timeoutMsg: "the session shown never filled",
    });
    expect(await style(sel.sessionRow(SESSION), ["height"])).toEqual({ height: "38px" });
  });

  it("shows Run as its icon only in a right panel header under 340 px", async () => {
    const label = () =>
      browser.execute((x: string) => {
        const run = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
        return getComputedStyle([...run.querySelectorAll("span")].find((e) => e.textContent === "Run")!).display;
      }, `${rightHeader}/button[1]`);
    expect(await label()).not.toBe("none");
    await browser.execute((x: string) => {
      (document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement).style.width = "330px";
    }, rightHeader);
    await browser.waitUntil(async () => (await label()) === "none", { timeoutMsg: "Run kept its label under 340 px" });
    await browser.execute((x: string) => {
      (document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement).style.width = "";
    }, rightHeader);
  });

  it("fades a scrolling view's edges with more to show, only those edges, and keeps its overscroll in", async () => {
    await openSettings("Appearance");
    const view = "//*[@data-settings-scroll]";
    const fadeOf = (edge: string) => $(`${view}/../span[@data-fade="${edge}"]`);
    await expect(fadeOf("bottom")).toBeExisting({ wait: 5_000 });
    await expect(fadeOf("top")).not.toBeExisting();
    // Settings' page sits in a pane too.
    expect(await style(`${view}/ancestor::div[contains(@class, "rounded-[10px]")][1]`, ["background-color", "border-top-left-radius"])).toEqual({ "background-color": PANE, "border-top-left-radius": "10px" });
    expect(await style(view, ["overscroll-behavior-y"])).toEqual({ "overscroll-behavior-y": "contain" });
    await browser.execute((x: string) => {
      const el = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as HTMLElement;
      el.scrollTop = el.scrollHeight;
    }, view);
    await expect(fadeOf("top")).toBeExisting({ wait: 5_000 });
    await expect(fadeOf("bottom")).not.toBeExisting({ wait: 5_000 });
    await closeSettings();
  });

  it("heads a session without a task with its name and branch", async () => {
    const s = rpc<{ name: string; branch: string }[]>(w, "session.list", {}).find((x) => x.name === SESSION)!;
    await expect($(`${sessionHeader}//h1`)).toHaveText(SESSION);
    await expect($(`${sessionHeader}//span[normalize-space()=${JSON.stringify(s.branch)}]`)).toBeDisplayed();
  });

  it("starts the header clear of the traffic lights while the sidebar is closed", async () => {
    const title = `${sessionHeader}//h1`;
    expect((await box(sessionHeader))!.left).toBeGreaterThan(0);
    await toggleSidebar();
    await browser.waitUntil(async () => (await box(sidebarHeader)) === null, { timeoutMsg: "the sidebar never closed" });
    // The column's pane sits 6 px from the window's edge.
    expect((await box(sessionPane))!.left).toBe(6);
    // The traffic lights end at about 70 px.
    expect((await box(title))!.left).toBeGreaterThanOrEqual(84);
    await toggleSidebar();
    await browser.waitUntil(async () => (await box(sidebarHeader)) !== null, { timeoutMsg: "the sidebar never opened again" });
  });

  it("shrinks crowded tabs to 112 px, then scrolls them with a fade and chevron on the side with hidden tabs", async () => {
    many = rpc<{ id: string }>(w, "session.create", { project_id: projectId(w), name: MANY, agent: "none" }).id;
    const path = rpc<{ id: string; path: string }[]>(w, "session.list", {}).find((x) => x.id === many)!.path;
    await $(sel.sessionRow(MANY)).click();
    for (let i = 0; i < 12; i++) rpc(w, "terminal.create", { cwd: path, session_id: many, kind: "shell", cols: 80, rows: 24 });
    await browser.waitUntil(async () => (await $$("[data-tab]").length) >= 12, { timeout: 15_000, timeoutMsg: "the twelve tabs never showed" });

    const widths = (await browser.execute(() => [...document.querySelectorAll("[data-tab]")].map((t) => t.getBoundingClientRect().width))) as number[];
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(112);
    // No scrollbar on the row.
    expect(await browser.execute(() => getComputedStyle(document.querySelector('[aria-label="Session tabs"]')!).scrollbarWidth)).toBe("none");
    // The row starts at its first tab: tabs are hidden on the right only.
    await expect($(scrollRight)).toBeDisplayed({ wait: 5_000 });
    await expect($(scrollLeft)).not.toBeExisting();
    // The badge counts the tabs wholly or partly out of the row's view.
    const out = await browser.execute(() => {
      const row = document.querySelector('[aria-label="Session tabs"]')!.getBoundingClientRect();
      return [...document.querySelectorAll("[data-tab]")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.left < row.left - 1 || r.right > row.right + 1;
      }).length;
    });
    expect(out).toBeGreaterThan(0);
    await expect($('//button[@aria-label="All tabs"]/span[@aria-label]')).toHaveText(String(out));
  });

  it("lists every tab in All tabs, filters them, and shows the one picked", async () => {
    await $(allTabs).click();
    const list = $('//div[@role="dialog"][@aria-label="All tabs"]');
    await expect(list).toBeDisplayed();
    await expect(list.$$('.//button[@role="option"]')).toBeElementsArrayOfSize(await $$("[data-tab]").length);
    await fill('//input[@aria-label="Filter tabs"]', "no-such-tab");
    await expect(list.$(sel.text("No tabs match"))).toBeDisplayed();
    await fill('//input[@aria-label="Filter tabs"]', "");
    await list.$('(.//button[@role="option"])[last()]').click();
    await expect(list).not.toBeExisting();
    // The last tab shows, and the row scrolls to it: hidden tabs are on the left now.
    await expect($("(//*[@data-tab])[last()]")).toHaveAttribute("aria-selected", "true");
    await expect($(scrollLeft)).toBeDisplayed({ wait: 5_000 });
    await expect($(scrollRight)).not.toBeExisting({ wait: 5_000 });
  });

  it("scrolls the row with its chevrons", async () => {
    await $(scrollLeft).click();
    await expect($(scrollRight)).toBeDisplayed({ wait: 5_000 });
  });

  it("grows its bars and rows with the largest font size, so no text outgrows its row", async () => {
    await setFontSize("24");
    // 24 / 13 of the design's heights: 44 → 81, 36 → 66.
    await browser.waitUntil(async () => ((await box(rightHeader))?.height ?? 0) > 80, { timeoutMsg: "the header never grew" });
    for (const x of [sidebarHeader, sessionHeader, rightHeader]) expect((await box(x))!.height).toBeGreaterThan(80);
    expect((await box(tabRow))!.height).toBeGreaterThan(65);
    expect((await box(viewRow))!.height).toBeGreaterThan(65);
    // The sidebar's New session, Run action and History each keep to one line, one under the other.
    const rows = (await browser.execute(() =>
      ["New session", "Run action", "History"].map((label) => {
        const b = [...document.querySelectorAll("aside nav button")].find((e) => e.textContent?.startsWith(label)) as HTMLElement;
        const text = b.querySelector("span.truncate") as HTMLElement;
        const r = b.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, wraps: text.getBoundingClientRect().height > r.height };
      }),
    )) as { top: number; bottom: number; wraps: boolean }[];
    expect(rows.map((r) => r.wraps)).toEqual([false, false, false]);
    expect(rows[0].bottom).toBeLessThanOrEqual(rows[1].top);
    expect(rows[1].bottom).toBeLessThanOrEqual(rows[2].top);
    // The terminal's command line shows its whole line.
    const input = (await browser.execute(() => {
      const t = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[placeholder="Type a command…"]')].find((e) => e.offsetParent !== null)!;
      return { client: t.clientHeight, scroll: t.scrollHeight };
    })) as { client: number; scroll: number };
    expect(input.scroll).toBeLessThanOrEqual(input.client);
    await setFontSize("13");
    await browser.waitUntil(async () => (await box(rightHeader))?.height === 44, { timeoutMsg: "the header never came back to 44 px" });
  });

  it("puts the right panel's views that don't fit into More, keeping the one shown in the row", async () => {
    await $("#right-tab-files").click();
    await setFontSize("19.5");
    const more = $('button[aria-label^="More views"]');
    await expect(more).toBeDisplayed({ wait: 10_000 });
    // The view shown stays.
    await expect($("#right-tab-files")).toHaveAttribute("aria-selected", "true");
    await more.click();
    const menu = $('//div[@role="menu"][@aria-label="More views"]');
    await expect(menu.$('.//button[normalize-space()="Review"]')).toBeDisplayed();
    await menu.$('.//button[normalize-space()="Review"]').click();
    await expect($("#right-tab-review")).toHaveAttribute("aria-selected", "true");
    await setFontSize("13");
    await expect(more).not.toBeExisting({ wait: 10_000 });
  });
});
