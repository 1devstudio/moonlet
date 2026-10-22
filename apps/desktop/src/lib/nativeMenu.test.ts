import { afterEach, describe, expect, it } from "vitest";
import { hideNativeContextMenu } from "./nativeMenu";

function rightClick(el: Element): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(e);
  return e;
}

describe("hideNativeContextMenu", () => {
  let undo = () => {};
  afterEach(() => {
    undo();
    document.body.innerHTML = "";
  });

  it("stops the webview's own menu (Back, Forward, Reload) on a right-click anywhere", () => {
    document.body.innerHTML = `<div><button>2 tool calls</button></div><input /><p>text</p>`;
    undo = hideNativeContextMenu(window);
    for (const sel of ["button", "input", "p"]) {
      expect(rightClick(document.querySelector(sel)!).defaultPrevented).toBe(true);
    }
  });

  it("stops it even when a handler stops the event from bubbling", () => {
    document.body.innerHTML = `<div id="row"></div>`;
    const row = document.getElementById("row")!;
    row.addEventListener("contextmenu", (e) => e.stopPropagation());
    undo = hideNativeContextMenu(window);
    expect(rightClick(row).defaultPrevented).toBe(true);
  });

  it("still lets the app open its own menu", () => {
    document.body.innerHTML = `<div id="row"></div>`;
    const opened: string[] = [];
    document.getElementById("row")!.addEventListener("contextmenu", () => opened.push("row menu"));
    undo = hideNativeContextMenu(window);
    rightClick(document.getElementById("row")!);
    expect(opened).toEqual(["row menu"]);
  });
});
