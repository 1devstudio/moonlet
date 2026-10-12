// Removing a project from a section (X5, X32).

import { $, $$, browser, expect } from "@wdio/globals";
import { PROJECT, projectId, rpc, sel, world } from "../fixtures";

const w = world();
const projectHeaders = () => $$(`//div[contains(@class, "group")][.//span[normalize-space()="${PROJECT}"]][.//button[@title="New session"]]`);

describe("Section projects", () => {
  it("removes a shared project from one section from the project row's context menu", async () => {
    const id = projectId(w);
    const personal = rpc<{ id: string; section_ids: string[] }[]>(w, "workspace.list", {})[0];
    const first = rpc<{ id: string; name: string }[]>(w, "section.list", {}).find((s) => s.id === personal.section_ids[0])!;
    const other = rpc<{ id: string }>(w, "section.create", { workspace_id: personal.id, name: "Acme" });
    rpc(w, "section.add_project", { id: other.id, path: w.repo });
    await expect(projectHeaders()).toBeElementsArrayOfSize(2);

    // The embedded driver's right click does not raise `contextmenu`.
    await browser.execute((el) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    }, await projectHeaders()[0]);
    await $(sel.button(`Remove from ${first.name}`)).click();

    await expect(projectHeaders()).toBeElementsArrayOfSize(1);
    const holders = rpc<{ name: string; project_ids: string[] }[]>(w, "section.list", {})
      .filter((x) => x.project_ids.includes(id))
      .map((x) => x.name);
    expect(holders).toEqual(["Acme"]);

    // Leave the shared world as the other specs expect it: deleting the
    // section hands its project back to the workspace's other section.
    rpc(w, "section.delete", { id: other.id });
    await expect(projectHeaders()).toBeElementsArrayOfSize(1);
  });
});
