import { describe, expect, it } from "vitest";
import { renderUrl, verdict } from "./renderPage";

const job = {
  id: 7,
  workspace: "w-1devstudio",
  path: "systems/storefront kit/components/buttons/button/button.html",
  viewport: [320, 140] as [number, number],
  variant: null,
};

const button = {
  name: "Button",
  fallback: false,
  errors: [],
  fixedOutside: 0,
  cells: [{ snippet: "buttons/button/primary", html: '<button class="btn">Run</button>', text: "Run", empty: false, textHeight: 17, painted: 1, overflow680: 0, escaped: 0 }],
};

describe("the render page (X64)", () => {
  it("frames the card on the moonlet-design scheme with its job, and the variant to show alone", () => {
    expect(renderUrl(job)).toBe("moonlet-design://w-1devstudio/systems/storefront%20kit/components/buttons/button/button.html?moonlet-render=7");
    expect(renderUrl({ ...job, variant: "buttons/button/ghost" })).toBe(
      "moonlet-design://w-1devstudio/systems/storefront%20kit/components/buttons/button/button.html?moonlet-render=7&variant=buttons%2Fbutton%2Fghost",
    );
  });

  it("judges the measurements its job's card posts", () => {
    expect(verdict({ type: "moonlet-render", job: "7", metrics: button, errors: [] }, 7)).toEqual({ metrics: { flags: [], errors: [] } });
    const empty = { ...button, errors: ["link did not load: ../../../styles.css"], cells: [{ ...button.cells[0], html: "", text: "", empty: true, textHeight: 0, painted: 0 }] };
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
