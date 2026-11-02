#!/usr/bin/env node
// Points latest.json at the release's own folder (X69). tauri-action uploads
// to a draft release, whose assets have no public download URL yet, so it
// writes api.github.com asset URLs instead. A host's moonletd 0.1.34 or
// 0.1.35 takes an archive only from `…/releases/download/<tag>/`, and
// refused those.
//
//   release-urls.mjs <latest.json> <assets.json> <owner/repo> <tag>
//
// <assets.json> is `gh release view <tag> --json assets`. Prints the new
// latest.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `latest` with each platform's URL in `…/releases/download/<tag>/`. */
export function releaseUrls(latest, assets, repo, tag) {
  const base = `https://github.com/${repo}/releases/download/${tag}/`;
  const platforms = {};
  for (const [platform, entry] of Object.entries(latest.platforms)) {
    const name = entry.url.startsWith(base) ? entry.url.slice(base.length) : assets.find((a) => a.apiUrl === entry.url)?.name;
    if (!name || !assets.some((a) => a.name === name)) throw new Error(`${platform}: ${entry.url} is no asset of ${tag}`);
    platforms[platform] = { ...entry, url: base + name };
  }
  return { ...latest, platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [latest, assets, repo, tag] = process.argv.slice(2);
  const read = (f) => JSON.parse(readFileSync(f, "utf8"));
  process.stdout.write(JSON.stringify(releaseUrls(read(latest), read(assets).assets, repo, tag), null, 2) + "\n");
}
