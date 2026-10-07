// Builds moonletd and the moonlet CLI and places them where Tauri expects them:
// - debug: next to the app binary in target/debug (found as siblings at runtime)
// - release: src-tauri/binaries/<name>-<triple> for `externalBin` bundling
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const release = process.argv.includes("--release");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const args = ["build", "-p", "moonletd", "-p", "moonlet-cli"];
if (release) args.push("--release");
execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

if (release) {
  const triple = execFileSync("rustc", ["--print", "host-tuple"]).toString().trim();
  const out = join(here, "..", "src-tauri", "binaries");
  mkdirSync(out, { recursive: true });
  for (const name of ["moonletd", "moonlet"]) {
    copyFileSync(join(root, "target", "release", name), join(out, `${name}-${triple}`));
  }
}
