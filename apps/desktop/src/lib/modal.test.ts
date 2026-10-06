import { afterEach, describe, expect, it } from "vitest";
import { fromOtherDialog, tabWrap } from "./modal";

// Settings open, with the confirm modal on top of it.
function screen() {
  document.body.innerHTML = `
    <div role="dialog" aria-label="Settings"><button id="toggle">Daemon</button></div>
    <div role="dialog" aria-label="Stop the background daemon"><button id="turn-off">Turn off</button></div>
    <button id="outside">Run</button>`;
  const $ = (id: string) => document.getElementById(id)!;
  const settings = document.querySelector('[aria-label="Settings"]');
  const esc = (target: Element) => {
    const e = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(e, "target", { value: target });
    return e;
  };
  return { $, settings, esc };
}

describe("fromOtherDialog", () => {
  afterEach(() => (document.body.innerHTML = ""));

  it("leaves Escape in the confirm modal to the confirm, not to Settings beneath it", () => {
    const { $, settings, esc } = screen();
    expect(fromOtherDialog(esc($("turn-off")), settings)).toBe(true);
  });

  it("gives Settings the keys pressed inside it", () => {
    const { $, settings, esc } = screen();
    expect(fromOtherDialog(esc($("toggle")), settings)).toBe(false);
  });

  it("gives Settings the keys pressed outside any dialog", () => {
    const { $, settings, esc } = screen();
    expect(fromOtherDialog(esc($("outside")), settings)).toBe(false);
  });
});

describe("tabWrap", () => {
  afterEach(() => (document.body.innerHTML = ""));

  // The Archive confirm: Close, the checkbox, Cancel, Archive.
  function confirm() {
    document.body.innerHTML = `
      <div role="dialog" aria-label="Archive session" tabindex="-1">
        <button id="close">×</button>
        <label><input id="box" type="checkbox"> Also delete the branch</label>
        <button id="cancel">Cancel</button>
        <button id="archive">Archive</button>
      </div>`;
    const $ = (id: string) => document.getElementById(id)!;
    return { $, panel: document.querySelector('[role="dialog"]')! };
  }

  it("wraps Tab from the last control to the first", () => {
    const { $, panel } = confirm();
    expect(tabWrap(panel, $("archive"), false)).toBe($("close"));
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const { $, panel } = confirm();
    expect(tabWrap(panel, $("close"), true)).toBe($("archive"));
  });

  it("brings focus back in from the panel itself", () => {
    const { $, panel } = confirm();
    expect(tabWrap(panel, panel, true)).toBe($("archive"));
  });

  it("leaves Tab alone between controls inside", () => {
    const { $, panel } = confirm();
    expect(tabWrap(panel, $("box"), false)).toBeNull();
    expect(tabWrap(panel, $("cancel"), true)).toBeNull();
  });
});
