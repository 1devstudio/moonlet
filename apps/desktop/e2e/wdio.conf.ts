// WebdriverIO config for the e2e tests (X12). Build first: `pnpm e2e:build`.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { APP, setUp, tearDown, world } from "./fixtures";

if (!existsSync(APP)) throw new Error(`${APP} is missing; run \`pnpm e2e:build\` first`);

// The launcher creates the scratch world once; workers find it through env.
if (!process.env.MOONLET_E2E_ROOT) process.env.MOONLET_E2E_ROOT = setUp().root;
const w = world();
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: APP },
      "wdio:tauriServiceOptions": { driverProvider: "embedded", env: w.env, captureBackendLogs: true, backendLogLevel: "warn" },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", { driverProvider: "embedded", env: w.env }]],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15_000,
  async before() {
    // The specs drive the main window. An explicit switch tells the service
    // so, which stops it from probing window focus (5 s each) before every
    // command. Handles are window labels; the hidden window that renders
    // design cards (X64), once it exists, sorts before "main".
    const handles = await browser.getWindowHandles();
    await browser.switchToWindow(handles.includes("main") ? "main" : handles[0]);
  },
  async afterTest(test, _context, { passed }) {
    if (passed) return;
    // A picture of the window for every failure, in e2e/artifacts (ignored).
    // A window that froze never takes it, so the test's own error is kept.
    mkdirSync(ARTIFACTS, { recursive: true });
    const shot = browser.saveScreenshot(join(ARTIFACTS, `${test.title.replace(/[^\w-]+/g, "_")}.png`));
    await Promise.race([shot.catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
  },
  onComplete() {
    tearDown(w);
  },
};
