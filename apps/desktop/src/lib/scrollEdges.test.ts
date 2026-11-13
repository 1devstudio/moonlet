import { describe, expect, it } from "vitest";
import { scrollEdges } from "./scrollEdges";

describe("scrollEdges (X94)", () => {
  it("shows no fade and no Latest when everything fits", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toEqual({ atTop: true, atBottom: true, far: false });
  });

  it("fades the bottom at the top of a long view, and offers Latest once more than 240 px from the end", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 2000, clientHeight: 600 })).toEqual({ atTop: true, atBottom: false, far: true });
  });

  it("fades both edges in the middle, without Latest within 240 px of the end", () => {
    expect(scrollEdges({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 600 })).toEqual({ atTop: false, atBottom: false, far: false });
    expect(scrollEdges({ scrollTop: 1159, scrollHeight: 2000, clientHeight: 600 })).toEqual({ atTop: false, atBottom: false, far: true });
  });

  it("fades only the top at the end, ignoring the pixel WebKit leaves", () => {
    expect(scrollEdges({ scrollTop: 1399.5, scrollHeight: 2000, clientHeight: 600 })).toEqual({ atTop: false, atBottom: true, far: false });
    expect(scrollEdges({ scrollTop: 0.5, scrollHeight: 2000, clientHeight: 600 })).toEqual({ atTop: true, atBottom: false, far: true });
  });
});
