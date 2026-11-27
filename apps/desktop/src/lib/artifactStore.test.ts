import { beforeEach, describe, expect, it, vi } from "vitest";
import { addChip, attachChips, chipsOf, removeChip, useArtifacts, type ArtifactChip } from "./artifactStore";

/** What the daemon answers, by host and method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);

vi.mock("./daemon", () => {
  class DaemonError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  }
  return {
    DaemonError,
    rpc: vi.fn((host: string, method: string, params: unknown) => {
      const answer = answers[`${host} ${method}`];
      return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
    }),
    onDaemonEvent: () => Promise.resolve(() => {}),
    onHostStatus: () => Promise.resolve(() => {}),
    subscribeHost: () => Promise.resolve(),
    hostsApi: {},
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const plan: ArtifactChip = { host: "local", id: "plan:a1b2c3d4e5f6:search-plan", name: "Add search", kind: "plan" };
const design: ArtifactChip = { host: "local", id: "design:workspace:0f9e8d7c6b5a:settings-page", name: "Settings page", kind: "design" };

beforeEach(() => {
  useArtifacts.setState({ chips: {} });
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("chipsOf", () => {
  it("gives a session with no chips the same empty list each time", () => {
    const first = chipsOf(useArtifacts.getState(), "local", "s-api");
    useArtifacts.setState({ query: "search" });
    expect(chipsOf(useArtifacts.getState(), "local", "s-api")).toBe(first);
    expect(first).toEqual([]);
  });
});

describe("addChip", () => {
  it("picks an artifact once, and the same id on another Mac apart", () => {
    addChip("local", "s-api", plan);
    addChip("local", "s-api", plan);
    addChip("local", "s-api", { ...design, host: "studio" });
    addChip("local", "s-api", design);
    expect(chipsOf(useArtifacts.getState(), "local", "s-api").map((c) => `${c.host} ${c.id}`)).toEqual([
      "local plan:a1b2c3d4e5f6:search-plan",
      "studio design:workspace:0f9e8d7c6b5a:settings-page",
      "local design:workspace:0f9e8d7c6b5a:settings-page",
    ]);

    removeChip("local", "s-api", { host: "studio", id: design.id });
    expect(chipsOf(useArtifacts.getState(), "local", "s-api").map((c) => `${c.host} ${c.id}`)).toEqual([
      "local plan:a1b2c3d4e5f6:search-plan",
      "local design:workspace:0f9e8d7c6b5a:settings-page",
    ]);
  });
});

describe("attachChips", () => {
  it("refers the session to each artifact picked, in order, gives their lines and clears them", async () => {
    const asked: unknown[] = [];
    answers["local artifact.attach"] = (p) => {
      asked.push(p);
      const id = (p as { id: string }).id;
      return { folder: `/refs/s-api/${id}`, line: `Artifact ${id}` };
    };
    addChip("local", "s-api", plan);
    addChip("local", "s-api", design);

    const lines = await attachChips("local", "s-api");

    expect(asked).toEqual([
      { session: "s-api", id: "plan:a1b2c3d4e5f6:search-plan" },
      { session: "s-api", id: "design:workspace:0f9e8d7c6b5a:settings-page" },
    ]);
    expect(lines).toEqual(["Artifact plan:a1b2c3d4e5f6:search-plan", "Artifact design:workspace:0f9e8d7c6b5a:settings-page"]);
    expect(chipsOf(useArtifacts.getState(), "local", "s-api")).toEqual([]);
  });

  it("keeps an artifact of another Mac picked, and says why", async () => {
    addChip("local", "s-api", { ...design, host: "studio" });
    await expect(attachChips("local", "s-api")).rejects.toThrow("Settings page is on another host: a session refers to the artifacts of its own host for now");
    expect(chipsOf(useArtifacts.getState(), "local", "s-api")).toHaveLength(1);
  });
});
