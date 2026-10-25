import { describe, expect, it } from "vitest";
import { chatOpensOn, designBar, pageFixMessage, type BarState } from "./designBars";

const problem = (path: string, kind: string, message: string, line = 3) => ({ path, line, kind, message });
const calm: BarState = { working: false, needsYou: null, page: "index", problems: [], system: "moonlet-desktop", systemRemoved: false, unsaved: null };

describe("the bar over the canvas (X65)", () => {
  it("shows none while nothing needs saying", () => {
    expect(designBar(calm)).toBeNull();
  });

  it("is orange with Stop while the agent works", () => {
    expect(designBar({ ...calm, working: true })).toEqual({
      tone: "orange",
      text: "Claude is changing the design. Edit mode opens when it stops; comments still work",
      detail: null,
      actions: ["stop"],
    });
  });

  it("is orange when the agent asks or needs an approval", () => {
    expect(designBar({ ...calm, needsYou: { kind: "question", text: "Rows or cards for the Git section?" } })).toEqual({ tone: "orange", text: "Claude asks…", detail: "Rows or cards for the Git section?", actions: [] });
    expect(designBar({ ...calm, needsYou: { kind: "approval", text: "Bash: rm -rf assets" } })).toEqual({ tone: "orange", text: "Claude needs your approval", detail: "Bash: rm -rf assets", actions: [] });
  });

  it("is red with Details and Ask the agent to fix when the shown page fails the check", () => {
    const problems = [
      problem("pages/git-b.html", "missing_mid", "<h2> has no data-mid"),
      problem("pages/git-b.html", "missing_mid", "<p> has no data-mid", 4),
      problem("pages/git-b.html", "duplicate_mid", '<p> repeats data-mid="m31"', 9),
      problem("pages/index.html", "stylesheet", "https://cdn.example.com/kit.css is not the design system's styles.css"),
    ];
    expect(designBar({ ...calm, page: "git-b", problems })).toEqual({
      tone: "red",
      text: "git-b.html has check problems:",
      detail: "2 elements without data-mid, 1 repeated data-mid",
      actions: ["details", "fix"],
    });
    expect(designBar({ ...calm, page: "index", problems })?.detail).toBe("1 other stylesheet");
    // Overview names the first page with a problem.
    expect(designBar({ ...calm, page: null, problems })?.text).toBe("git-b.html has check problems:");
  });

  it("is yellow with Dismiss when a save raced a change on disk, naming the edit not saved", () => {
    expect(designBar({ ...calm, unsaved: "index.html m30 div: deleted" })).toEqual({
      tone: "yellow",
      text: "The page changed; your last edit was not saved.",
      detail: "index.html m30 div: deleted",
      actions: ["dismiss"],
    });
  });

  it("is grey when the design system was removed", () => {
    expect(designBar({ ...calm, systemRemoved: true })).toEqual({ tone: "grey", text: "Design system removed.", detail: "Pages show without moonlet-desktop's styles.", actions: [] });
  });

  it("shows one bar at a time: the agent at work, then what it asks, then an edit not saved, then the check, then the design system", () => {
    const all: BarState = { working: true, needsYou: { kind: "question", text: "Which?" }, page: "index", problems: [problem("pages/index.html", "missing_mid", "<h1> has no data-mid")], system: "moonlet-desktop", systemRemoved: true, unsaved: "index.html m30 div: deleted" };
    expect(designBar(all)?.text).toBe("Claude is changing the design. Edit mode opens when it stops; comments still work");
    expect(designBar({ ...all, working: false })?.text).toBe("Claude asks…");
    expect(designBar({ ...all, working: false, needsYou: null })?.text).toBe("The page changed; your last edit was not saved.");
    expect(designBar({ ...all, working: false, needsYou: null, unsaved: null })?.text).toBe("index.html has check problems:");
    expect(designBar({ ...all, working: false, needsYou: null, unsaved: null, problems: [] })?.text).toBe("Design system removed.");
  });
});

describe("Ask the agent to fix (X65)", () => {
  it("sends the page's check problems by line, and asks for the check again", () => {
    const problems = [problem("pages/git-b.html", "missing_mid", "<h2> has no data-mid", 12), problem("pages/git-b.html", "duplicate_mid", '<p> repeats data-mid="m31"', 40)];
    expect(pageFixMessage("git-b", problems)).toBe('Fix the check problems of pages/git-b.html, then run the check again:\n- line 12: <h2> has no data-mid\n- line 40: <p> repeats data-mid="m31"');
  });
});

describe("the design's chat panel on an ask (X65)", () => {
  const ask = { kind: "question" as const, text: "Rows or cards?" };

  it("opens when the agent starts to need the user, and not again while it still does", () => {
    expect(chatOpensOn(null, ask)).toBe(true);
    // The same ask listed again, or another while one waits: the user may have folded it.
    expect(chatOpensOn(ask, { ...ask })).toBe(false);
    expect(chatOpensOn(ask, { kind: "approval", text: "Bash: rm -rf assets" })).toBe(false);
    expect(chatOpensOn(ask, null)).toBe(false);
    expect(chatOpensOn(null, null)).toBe(false);
  });
});
