import { describe, expect, it } from "vitest";
import type { DesignComment } from "./protocol";
import { boxLabel, commentCards, footerLabel, pinLabel, sentLabel, commentLine, commentsTab, isOrphaned, pageCounts, parseCommentLine, sendAll } from "./designComments";

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
    expect(sendAll(pins, { index: ["m1", "m12", "m33"] })).toEqual({
      pins: [3, 5],
      text: 'Comment on index.html [data-mid=m33] (div "Warn before losing unpushed work"): Switch rows need more space between them\nComment on git-a.html [data-mid=m7] (section "Git"): Cards are too tall',
    });
    expect(sendAll([pin(1, { sent_at: 5 })], {})).toBeNull();
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
    expect(boxLabel({ tag: "nav", mid: "m12", text: "General Appearance" })).toBe('nav · m12 · "General Appearance"');
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
