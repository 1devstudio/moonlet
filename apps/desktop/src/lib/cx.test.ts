import { describe, expect, it } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it("joins classes and skips falsy ones", () => {
    expect(cx("flex", false, null, undefined, "gap-2")).toBe("flex gap-2");
  });

  it("lets a later class win over an earlier one for the same property", () => {
    expect(cx("w-full rounded-md px-2.5", "w-[130px]")).toBe("rounded-md px-2.5 w-[130px]");
    expect(cx("inline-flex h-6 w-6", "h-7 w-7")).toBe("inline-flex h-7 w-7");
    expect(cx("ui-text-12 text-muted", "ui-text-13")).toBe("text-muted ui-text-13");
  });

  it("keeps a colour and a size of the app's text together", () => {
    expect(cx("ui-text-11.5 text-faint", "text-accent-2")).toBe("ui-text-11.5 text-accent-2");
  });
});
