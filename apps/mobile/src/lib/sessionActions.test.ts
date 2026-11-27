import { describe, expect, it } from "vitest";
import { actionCall, menuItems, viewCall } from "./sessionActions";
import { NOW, session } from "./fixtures";
import type { Section } from "@desktop/lib/protocol";

describe("menuItems (X118)", () => {
  it("lists the desktop's session menu without what only the Mac can do", () => {
    const s = session("dark", "Dark mode for account pages");
    expect(menuItems(s, { linked: false, sources: true, pr: true })).toEqual(["open", "open-pr", "-", "pin-top", "rename", "fork", "-", "move-workspace", "move-under", "-", "link-task", "-", "archive"]);
    expect(menuItems({ ...s, pinned_top: true }, { linked: true, sources: true, pr: false })).toEqual(["open", "-", "unpin-top", "rename", "fork", "-", "move-workspace", "move-under", "-", "archive"]);
  });

  it("gives another member's session Open, and Archive while that member is reachable (X88)", () => {
    const s = session("x", "x", { owner: { worker: "mini", name: "studio-mini", reachable: true } });
    expect(menuItems(s, { linked: false, sources: true, pr: true })).toEqual(["open", "-", "archive"]);
    expect(menuItems({ ...s, owner: { ...s.owner!, reachable: false } }, { linked: false, sources: true, pr: true })).toEqual(["open"]);
  });
});

describe("actionCall (X118)", () => {
  it("saves each change to a session as the desktop's menu does", () => {
    const s = session("dark", "Dark mode for account pages");
    expect(actionCall(s, { kind: "pin-top" })).toEqual({ method: "session.update", params: { id: "dark", pinned_top: true } });
    expect(actionCall(s, { kind: "unpin-top" })).toEqual({ method: "session.update", params: { id: "dark", pinned_top: false } });
    expect(actionCall(s, { kind: "rename", name: "  Dark mode, all pages " })).toEqual({ method: "session.update", params: { id: "dark", name: "Dark mode, all pages" } });
    expect(actionCall(s, { kind: "move-workspace", workspace: "work" })).toEqual({ method: "session.update", params: { id: "dark", workspace_id: "work" } });
    expect(actionCall(s, { kind: "move-under", parent: "add-search" })).toEqual({ method: "session.update", params: { id: "dark", parent: "add-search" } });
    expect(actionCall(s, { kind: "move-under", parent: null })).toEqual({ method: "session.update", params: { id: "dark", parent: null } });
    expect(actionCall(s, { kind: "fork" })).toEqual({ method: "session.fork", params: { id: "dark" } });
  });

  it("saves nothing for an empty or unchanged name", () => {
    const s = session("dark", "Dark mode for account pages");
    expect(actionCall(s, { kind: "rename", name: "   " })).toBeNull();
    expect(actionCall(s, { kind: "rename", name: "Dark mode for account pages" })).toBeNull();
  });
});

describe("viewCall (X118)", () => {
  const sec: Section = { id: "dev", name: "1devstudio", project_ids: ["storefront", "changedeck", "docs"], view: { group_by: "project", sort_by: "recent", filter: [] }, created_at: NOW };

  it("saves the section's grouping or sorting with section.update, keeping the rest of its view", () => {
    expect(viewCall(sec, { group_by: "status" }, sec.project_ids)).toEqual({ method: "section.update", params: { id: "dev", view: { group_by: "status", sort_by: "recent", filter: [] } } });
    expect(viewCall(sec, { sort_by: "name" }, sec.project_ids)).toEqual({ method: "section.update", params: { id: "dev", view: { group_by: "project", sort_by: "name", filter: [] } } });
  });

  it("unticks a project from the filter, and ticking it back shows every project again", () => {
    const less = viewCall(sec, { toggle: "changedeck" }, sec.project_ids);
    expect(less.params.view.filter).toEqual(["storefront", "docs"]);
    const back = viewCall({ ...sec, view: less.params.view }, { toggle: "changedeck" }, sec.project_ids);
    expect(back.params.view.filter).toEqual([]);
  });

  it("counts only the projects its host has, as the desktop does, and All projects shows every one", () => {
    // "docs" is listed in the section but its host no longer has it.
    const here = ["storefront", "changedeck"];
    const less = viewCall(sec, { toggle: "changedeck" }, here);
    expect(less.params.view.filter).toEqual(["storefront"]);
    expect(viewCall({ ...sec, view: less.params.view }, { toggle: "changedeck" }, here).params.view.filter).toEqual([]);
    expect(viewCall({ ...sec, view: less.params.view }, { all: true }, here).params.view.filter).toEqual([]);
  });
});
