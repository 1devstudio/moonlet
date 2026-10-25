import { describe, expect, it } from "vitest";
import { handBack, renderUrl, verdict } from "./renderPage";

const job = {
  id: 7,
  workspace: "w-1devstudio",
  slug: "storefront kit",
  path: "components/buttons/button/button.html",
  viewport: [320, 140] as [number, number],
  variant: null,
};

const button = {
  name: "Button",
  fallback: false,
  errors: [],
  outside: 0,
  cells: [{ snippet: "buttons/button/primary", html: '<button class="btn">Run</button>', text: "Run", empty: false, smallestText: 17, painted: 1, overflow680: 0, escaped: 0 }],
};

describe("the render page (X64)", () => {
  it("frames the card on the moonlet-design scheme with its job, and the variant to show alone", () => {
    expect(renderUrl(job)).toBe("moonlet-design://6555e5faa68d4eba.w-1devstudio/systems/storefront%20kit/components/buttons/button/button.html?moonlet-render=7");
    expect(renderUrl({ ...job, variant: "buttons/button/ghost" })).toBe(
      "moonlet-design://6555e5faa68d4eba.w-1devstudio/systems/storefront%20kit/components/buttons/button/button.html?moonlet-render=7&variant=buttons%2Fbutton%2Fghost",
    );
  });

  it("judges the measurements its job's card posts", () => {
    expect(verdict({ type: "moonlet-render", job: "7", metrics: button, errors: [] }, 7)).toEqual({ metrics: { flags: [], errors: [] } });
    const empty = { ...button, errors: ["link did not load: ../../../styles.css"], cells: [{ ...button.cells[0], html: "", text: "", empty: true, smallestText: 0, painted: 0 }] };
    expect(verdict({ type: "moonlet-render", job: "7", metrics: empty, errors: empty.errors }, 7)).toEqual({
      metrics: { flags: ["rootEmpty", "errs", "allHollow", "thin", "bad"], errors: ["link did not load: ../../../styles.css"] },
    });
  });

  it("ignores a message about another job, or of another kind", () => {
    expect(verdict({ type: "moonlet-render", job: "6", metrics: button, errors: [] }, 7)).toBeNull();
    expect(verdict({ type: "moonlet-edit", job: "7" }, 7)).toBeNull();
    expect(verdict("moonlet-render", 7)).toBeNull();
  });

  it("says why when the card could not be measured", () => {
    expect(verdict({ type: "moonlet-render", job: "7", metrics: null, errors: ["the measuring script failed: TypeError"] }, 7)).toEqual({
      error: "the card could not be measured: the measuring script failed: TypeError",
    });
  });
});

describe("handing a verdict back (X64)", () => {
  const recorder = (refuse: number) => {
    const sent: unknown[] = [];
    const logged: string[] = [];
    let calls = 0;
    const send = async (cmd: string, args: Record<string, unknown>) => {
      sent.push([cmd, args]);
      calls += 1;
      if (calls <= refuse) throw { code: "forbidden", message: "only the app's render page renders cards" };
      return null;
    };
    return { sent, logged, send, log: (m: string) => logged.push(m) };
  };

  it("hands the verdict to the backend once when it takes it", async () => {
    const r = recorder(0);
    await handBack(7, { metrics: { flags: [], errors: [] } }, r.send, r.log);
    expect(r.sent).toEqual([["design_render_measured", { id: 7, metrics: { flags: [], errors: [] } }]]);
    expect(r.logged).toEqual([]);
  });

  it("hands back why when the backend refuses the verdict, and logs it", async () => {
    const r = recorder(1);
    await handBack(7, { metrics: { flags: ["bad"], errors: [] } }, r.send, r.log);
    expect(r.sent[1]).toEqual(["design_render_measured", { id: 7, error: "the render page could not hand back its verdict: only the app's render page renders cards" }]);
    expect(r.logged).toEqual(["the render page could not hand back card 7: only the app's render page renders cards"]);
  });

  it("logs both failures when the backend refuses the reason too", async () => {
    const r = recorder(2);
    await handBack(7, { error: "the card did not finish loading in 15 s" }, r.send, r.log);
    expect(r.sent).toHaveLength(2);
    expect(r.logged).toEqual([
      "the render page could not hand back card 7: only the app's render page renders cards",
      "the render page could not tell why either: only the app's render page renders cards",
    ]);
  });
});
