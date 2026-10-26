import { describe, expect, it } from "vitest";
import type { DesignComment } from "./protocol";
import { boxLabel, boxPlace, chatCardLookup, pinPlace, withMid, keepAction, openCommentsLabel, commentCards, footerLabel, pinLabel, sentLabel, commentLine, commentsMessage, commentsTab, isOrphaned, pageCounts, parseCommentLine, sendAll, withPins, type PageMids } from "./designComments";

const pin = (n: number, over: Partial<DesignComment> = {}): DesignComment => ({
  n,
  page: "index",
  mid: "m12",
  tag: "nav",
  text: "General Appearance Terminal Agents",
  comment: "Collapse into a menu on phone",
  sent_at: null,
  state: "open",
  ...over,
});

describe("a comment's line in the chat (X65)", () => {
  it("names the page, the element's data-mid, tag and text, then the comment", () => {
    expect(commentLine(pin(1))).toBe('Comment on index.html [data-mid=m12] (nav "General Appearance Terminal Agents"): Collapse into a menu on phone');
    expect(commentLine(pin(2, { page: "git-a", mid: "m25", tag: "h2", text: "Git", comment: "Make Git the first section,\nit is what people open this page for" }))).toBe(
      'Comment on git-a.html [data-mid=m25] (h2 "Git"): Make Git the first section, it is what people open this page for',
    );
  });
});

describe("a message of comments in the chat (X65)", () => {
  const nav = pin(1, { sent_at: 1 });
  const git = pin(2, { page: "git-a", mid: "m25", tag: "h2", text: 'The "Git" section', comment: "Make Git the first section", sent_at: 1 });

  it("reads a line back as its page, element and comment", () => {
    expect(parseCommentLine('Comment on git-a.html [data-mid=m25] (h2 "The "Git" section"): Make Git the first section')).toEqual({
      page: "git-a",
      mid: "m25",
      tag: "h2",
      text: 'The "Git" section',
      comment: "Make Git the first section",
    });
    expect(parseCommentLine("Comment on index.html: make it blue")).toBeNull();
    // Only the ids and tags a pin can have.
    expect(parseCommentLine('Comment on index.html [data-mid=m1x] (nav "x"): y')).toBeNull();
    expect(parseCommentLine(`Comment on index.html [data-mid=m1] (${"a".repeat(33)} "x"): y`)).toBeNull();
  });

  it("shows as Comment from the canvas cards, numbered like their pins, when every line is a comment's", () => {
    expect(commentCards(commentLine(nav), [nav, git])).toEqual([{ n: 1, page: "index", mid: "m12", tag: "nav", text: "General Appearance Terminal Agents", comment: "Collapse into a menu on phone" }]);
    // Send all's message: one card per line.
    expect(commentCards(`${commentLine(nav)}\n${commentLine(git)}`, [nav, git])?.map((c) => c.n)).toEqual([1, 2]);
    // A pin resolved or gone since: a card without a number.
    expect(commentCards(commentLine(git), [nav])?.map((c) => c.n)).toEqual([null]);
  });

  it("leaves any other message as it is", () => {
    expect(commentCards("Make the nav sticky", [nav])).toBeNull();
    expect(commentCards(`${commentLine(nav)}\nAnd make it sticky`, [nav])).toBeNull();
    expect(commentCards("", [nav])).toBeNull();
  });
});

describe("an orphaned pin (X65)", () => {
  it("is one whose element is gone from its page after the last load, or that names no element", () => {
    // The ids the page reported after it loaded again: m12 is gone.
    const mids = { index: ["m1", "m2", "m13", "m25"] };
    expect(isOrphaned(pin(1), mids)).toBe(true);
    expect(isOrphaned(pin(2, { mid: "m25" }), mids)).toBe(false);
    // A page not loaded yet: not known to be gone.
    expect(isOrphaned(pin(3, { page: "git-a" }), mids)).toBe(false);
    // Kept in a comments.json from before pins had a page.
    expect(isOrphaned(pin(4, { page: "", mid: "" }), mids)).toBe(true);
  });
});

describe("an element picked since the page's last report (X65)", () => {
  it("counts as there, so its new pin is not orphaned, until a later report leaves it out", () => {
    const menuItem = pin(4, { mid: "m41", tag: "li", text: "Rename" });
    const reported: PageMids = { index: ["m1", "m12"] };
    expect(isOrphaned(menuItem, reported)).toBe(true);
    const picked: PageMids = { index: withMid(reported.index, "m41") };
    expect(picked.index).toEqual(["m1", "m12", "m41"]);
    expect(isOrphaned(menuItem, picked)).toBe(false);
    expect(withMid(picked.index, "m41")).toEqual(["m1", "m12", "m41"]);
    // A page not reported since the app started stays not known.
    expect(withMid(undefined, "m41")).toBeUndefined();
    // The next report is the page again.
    expect(isOrphaned(menuItem, { index: ["m1", "m12"] })).toBe(true);
  });
});

describe("the Comments tab (X65)", () => {
  const pins = [
    pin(1, { sent_at: 1_761_380_280_000 }),
    pin(2, { mid: "m25", tag: "h2", text: "Git", comment: "Make Git the first section", sent_at: 1_761_380_400_000 }),
    pin(3, { mid: "m33", tag: "div", text: "Warn before losing unpushed work", comment: "Switch rows need more space between them" }),
    pin(4, { mid: "m41", tag: "a", text: "Advanced", comment: "Hide this behind a disclosure" }),
    pin(5, { page: "git-a", mid: "m7", tag: "section", text: "Git", comment: "Cards are too tall" }),
    pin(6, { mid: "m50", comment: "Done already", state: "resolved", sent_at: 1_761_380_000_000 }),
  ];
  // index loaded again without m41.
  const mids = { index: ["m1", "m12", "m25", "m33", "m50"] };

  it("lists the open pins with the orphaned ones apart, counts both tabs and the pins not sent yet", () => {
    const tab = commentsTab(pins, { tab: "open", page: null }, mids);
    expect(tab.shown.map((p) => p.n)).toEqual([1, 2, 3, 5]);
    expect(tab.orphaned.map((p) => p.n)).toEqual([4]);
    expect([tab.open, tab.resolved, tab.unsent]).toEqual([5, 1, 2]);
  });

  it("filters by page, and lists the resolved pins in Resolved", () => {
    const git = commentsTab(pins, { tab: "open", page: "git-a" }, mids);
    expect([git.shown.map((p) => p.n), git.orphaned.map((p) => p.n)]).toEqual([[5], []]);
    // The counts and the footer are the design's, whatever the filter.
    expect([git.open, git.resolved, git.unsent]).toEqual([5, 1, 2]);
    const resolved = commentsTab(pins, { tab: "resolved", page: null }, mids);
    expect([resolved.shown.map((p) => p.n), resolved.orphaned]).toEqual([[6], []]);
  });
});

describe("Send all (X65)", () => {
  it("sends every open pin not sent yet whose element is there as one message, one line each", () => {
    const pins = [
      pin(1, { sent_at: 5 }),
      pin(3, { mid: "m33", tag: "div", text: "Warn before losing unpushed work", comment: "Switch rows need more space between them" }),
      pin(4, { mid: "m41", tag: "a", text: "Advanced", comment: "Hide this behind a disclosure" }),
      pin(5, { page: "git-a", mid: "m7", tag: "section", text: "Git", comment: "Cards are too tall" }),
      pin(6, { mid: "m50", comment: "Done", state: "resolved" }),
    ];
    const all = sendAll(pins, { index: ["m1", "m12", "m33"] });
    expect(all.map((p) => p.n)).toEqual([3, 5]);
    expect(commentsMessage(all)).toBe(
      'Comment on index.html [data-mid=m33] (div "Warn before losing unpushed work"): Switch rows need more space between them\nComment on git-a.html [data-mid=m7] (section "Git"): Cards are too tall',
    );
    expect(sendAll([pin(1, { sent_at: 5 })], {})).toEqual([]);
  });
});

describe("a page's comments in Overview (X65)", () => {
  it("counts each page's open pins, orphaned ones included, as the design's row does", () => {
    const pins = [pin(1), pin(2, { mid: "m99" }), pin(3, { page: "git-a" }), pin(4, { page: "git-a", state: "resolved" }), pin(5, { page: "git-b", state: "resolved" })];
    expect(pageCounts(pins)).toEqual({ index: 2, "git-a": 1 });
  });
});

describe("how a pin is named (X65)", () => {
  it("names the element in the comment box, and its page too in the Comments tab", () => {
    // The text cut to 12 characters, its closing quote kept.
    expect(boxLabel({ tag: "nav", mid: "m12", text: "General Appearance" })).toBe('nav · m12 · "General Appe…"');
    expect(boxLabel({ tag: "h2", mid: "m25", text: "Git" })).toBe('h2 · m25 · "Git"');
    expect(boxLabel({ tag: "p", mid: "m30", text: "Branch prefi" })).toBe('p · m30 · "Branch prefi"');
    expect(boxLabel({ tag: "div", mid: "m40", text: "" })).toBe("div · m40");
    expect(pinLabel(pin(1))).toBe('index.html · m12 · nav "General Appearance Terminal Agents"');
  });

  it("says when it was sent, or that it was not, and how many Send all sends", () => {
    expect(sentLabel(pin(1, { sent_at: new Date(2026, 9, 25, 10, 18).getTime() }))).toBe("Sent 10:18");
    expect(sentLabel(pin(1, { sent_at: new Date(2026, 9, 25, 9, 5).getTime() }))).toBe("Sent 09:05");
    expect(sentLabel(pin(1))).toBe("Not sent");
    expect(footerLabel(2)).toBe("2 not sent yet, one line each");
    expect(footerLabel(1)).toBe("1 not sent yet, one line each");
    expect(footerLabel(0)).toBe("All sent");
  });
});

describe("pins the daemon gives back (X65)", () => {
  it("take their old selves' places, and new ones are added by number", () => {
    const list = [pin(1), pin(3)];
    expect(withPins(list, [pin(3, { sent_at: 7 }), pin(2)]).map((p) => [p.n, p.sent_at])).toEqual([
      [1, null],
      [2, null],
      [3, 7],
    ]);
  });
});

describe("the comment box (X65)", () => {
  // A Phone page (390 × 844) at 50%: 195 × 422 px on the canvas.
  const size: [number, number] = [195, 422];
  it("goes under its element, else above it, else inside the page for an element as tall as it", () => {
    expect(boxPlace({ x: 20, y: 40, w: 200, h: 40 }, 0.5, size)).toEqual({ left: 0, top: 48 });
    expect(boxPlace({ x: 0, y: 700, w: 390, h: 100 }, 0.5, size)).toEqual({ left: 0, top: 192 });
    expect(boxPlace({ x: 0, y: 0, w: 390, h: 844 }, 0.5, size)).toEqual({ left: 0, top: 8 });
  });

  it("keeps a new pin, changes a kept pin's comment, and leaves one whose text did not change", () => {
    expect(keepAction(null, "Collapse it")).toBe("new");
    expect(keepAction(pin(1), "Collapse into a menu on phone ")).toBe("unchanged");
    expect(keepAction(pin(1), "Collapse into a menu below 600 px")).toBe("edit");
  });
});

describe("a page's count in Overview (X65)", () => {
  it("says how many comments are open", () => {
    expect([openCommentsLabel(1), openCommentsLabel(3)]).toEqual(["1 open comment", "3 open comments"]);
  });
});

describe("Show in chat (X65)", () => {
  it("waits for the chat to load, at most 5 s, before saying the pin's message is not in it", () => {
    expect(chatCardLookup({ found: false, loaded: false, waitedMs: 0 })).toBe("wait");
    expect(chatCardLookup({ found: false, loaded: false, waitedMs: 4900 })).toBe("wait");
    expect(chatCardLookup({ found: true, loaded: true, waitedMs: 300 })).toBe("found");
    expect(chatCardLookup({ found: false, loaded: true, waitedMs: 300 })).toBe("missing");
    expect(chatCardLookup({ found: false, loaded: false, waitedMs: 5000 })).toBe("missing");
  });
});

describe("a pin over the page (X65)", () => {
  // A 1440×900 page shown at 50%.
  const at = (x: number, y: number, w: number, h: number) => pinPlace({ x, y, w, h }, 0.5, [720, 450]);
  it("goes at its element's top right corner, kept inside the page, and is hidden while its element is scrolled out of it", () => {
    expect(at(100, 200, 300, 40)).toEqual({ left: 190, top: 90 });
    // A full-width nav at the top: its pin stays inside the page.
    expect(at(0, 0, 1440, 60)).toEqual({ left: 700, top: 0 });
    // Scrolled partly out at the top: still shown, at the page's edge.
    expect(at(0, -30, 200, 60)).toEqual({ left: 90, top: 0 });
    // Scrolled out above, or below the page.
    expect(at(0, -300, 400, 100)).toBeNull();
    expect(at(0, 1000, 100, 20)).toBeNull();
  });
});
