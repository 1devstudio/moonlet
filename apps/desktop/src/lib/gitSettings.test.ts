import { describe, expect, it } from "vitest";
import { gitHosts, gitSettingsOf, tooOldText } from "./gitSettings";
import type { HostInfo } from "./protocol";

const host = (id: string, label: string, remote: boolean, status: HostInfo["status"] = "connected"): HostInfo => ({
  id,
  label,
  remote,
  status,
  message: null,
  daemon_version: null,
  hostname: null,
  home: null,
});

describe("gitSettingsOf", () => {
  it("stages all and opens ready PRs on a host whose settings are not known", () => {
    expect(gitSettingsOf({}, "local")).toEqual({ stage_all: true, draft_prs: false });
    expect(gitSettingsOf({ devbox: null }, "devbox")).toEqual({ stage_all: true, draft_prs: false });
  });

  it("is what the host's daemon keeps", () => {
    expect(gitSettingsOf({ devbox: { stage_all: false, draft_prs: true } }, "devbox")).toEqual({ stage_all: false, draft_prs: true });
  });
});

describe("gitHosts", () => {
  it("lists This Mac, then each connected remote host by its label", () => {
    const hosts = { local: host("local", "local", false), devbox: host("devbox", "devbox", true), mini: host("mini", "studio-mini", true, "reconnecting") };
    expect(gitHosts(hosts)).toEqual([
      { id: "local", label: "This Mac" },
      { id: "devbox", label: "devbox" },
    ]);
  });

  it("is only This Mac without remote hosts", () => {
    expect(gitHosts({ local: host("local", "local", false) })).toEqual([{ id: "local", label: "This Mac" }]);
  });
});

describe("tooOldText", () => {
  it("names the host whose daemon is too old", () => {
    expect(tooOldText("devbox")).toBe("devbox's moonletd is too old for Git settings. Reinstall the helper from Hosts.");
  });
});
