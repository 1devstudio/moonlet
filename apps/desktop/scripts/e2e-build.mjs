// Builds the app for the e2e tests (X12): the `e2e` cargo feature (embedded
// WebDriver server), the frontend embedded instead of the Vite dev server,
// and moonletd + moonlet next to it, all in target/e2e so a running `pnpm dev`
// is left alone.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const env = { ...process.env, CARGO_TARGET_DIR: join(desktop, "..", "..", "target", "e2e") };
execFileSync(
  "pnpm",
  ["tauri", "build", "--debug", "--no-bundle", "--features", "e2e", "--config", "src-tauri/tauri.e2e.conf.json"],
  { cwd: desktop, env, stdio: "inherit" },
);
