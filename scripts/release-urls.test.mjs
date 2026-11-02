// Tests for release-urls.mjs, with latest.json and the asset list of the
// published v0.1.35 release as captured from GitHub (signatures shortened).
import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseUrls } from "./release-urls.mjs";

const latest = {
  version: "0.1.35",
  notes: "Apple Silicon build, signed with a Developer ID and notarized by Apple. Installed apps update themselves from Settings › Updates.",
  pub_date: "2026-11-01T00:09:20.739Z",
  platforms: {
    "darwin-aarch64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6",
      url: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696833801",
    },
    "darwin-aarch64-app": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6",
      url: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696833801",
    },
  },
};

const assets = [
  { apiUrl: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696835218", name: "install.sh" },
  { apiUrl: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696833924", name: "latest.json" },
  { apiUrl: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696833801", name: "moonlet_0.1.35_aarch64.app.tar.gz" },
  { apiUrl: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696833877", name: "moonlet_0.1.35_aarch64.app.tar.gz.sig" },
  { apiUrl: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/696834906", name: "moonlet_0.1.35_aarch64.dmg" },
];

test("points every platform at its archive in the release's own folder", () => {
  const fixed = releaseUrls(latest, assets, "1devstudio/moonlet", "v0.1.35");
  assert.deepEqual(fixed.platforms, {
    "darwin-aarch64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6",
      url: "https://github.com/1devstudio/moonlet/releases/download/v0.1.35/moonlet_0.1.35_aarch64.app.tar.gz",
    },
    "darwin-aarch64-app": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6",
      url: "https://github.com/1devstudio/moonlet/releases/download/v0.1.35/moonlet_0.1.35_aarch64.app.tar.gz",
    },
  });
  assert.equal(fixed.version, "0.1.35");
  assert.equal(fixed.pub_date, "2026-11-01T00:09:20.739Z");
});

test("keeps a URL that already points into the release", () => {
  const url = "https://github.com/1devstudio/moonlet/releases/download/v0.1.35/moonlet_0.1.35_aarch64.app.tar.gz";
  const already = { ...latest, platforms: { "darwin-aarch64": { signature: "s", url } } };
  assert.equal(releaseUrls(already, assets, "1devstudio/moonlet", "v0.1.35").platforms["darwin-aarch64"].url, url);
});

test("refuses a URL that matches no asset of the release", () => {
  const stray = {
    ...latest,
    platforms: { "darwin-aarch64": { signature: "s", url: "https://api.github.com/repos/1devstudio/moonlet/releases/assets/1" } },
  };
  assert.throws(
    () => releaseUrls(stray, assets, "1devstudio/moonlet", "v0.1.35"),
    { message: "darwin-aarch64: https://api.github.com/repos/1devstudio/moonlet/releases/assets/1 is no asset of v0.1.35" },
  );
});
