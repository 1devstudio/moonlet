// Look at a UI change in the real app before reporting it: a screenshot of
// one element and the boxes of the ones that matter, from the app's own
// WebKit (a native <select> or the app's rem can differ from a browser).
//
// Write a throwaway spec in e2e/snaps/ (gitignored, outside the default run):
//
//   import { snap, stage } from "../snap";
//   describe("snap", () => it("dialog", async () => {
//     await stage(`<select class="...">…</select>`);   // or drive the app
//     console.log(await snap("select", "//div[@id='snap-stage']", { select: "//select" }));
//   }));
//
// then `pnpm e2e:build` and `pnpm e2e --spec e2e/snaps/<file>.ts`. Shots go
// to /tmp/moonlet-snap/<name>.png; read them before saying a change works.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { browser } from "@wdio/globals";
import { APP } from "./fixtures";

export const SNAP_DIR = "/tmp/moonlet-snap";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Puts `html` in a fixed panel over the app (id `snap-stage`, 360px wide), so
 * the app's classes and CSS can be checked without setting up app state.
 * The markup is the spec author's own, in the throwaway e2e app.
 */
export async function stage(html: string, width = 360): Promise<void> {
  await browser.execute(
    (markup: string, w: number) => {
      document.getElementById("snap-stage")?.remove();
      const box = document.createElement("div");
      box.id = "snap-stage";
      box.style.cssText = `position:fixed;left:24px;top:24px;z-index:99999;width:${w}px;padding:16px;background:#1f1f1f`;
      box.innerHTML = markup;
      document.body.appendChild(box);
    },
    html,
    width,
  );
}

// The e2e app's largest window on screen (the main one), by CGWindowID.
const WINDOW_NUMBER_SCRIPT = `ObjC.import("CoreGraphics");
function run(pids) {
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  const area = (w) => w.kCGWindowBounds.Width * w.kCGWindowBounds.Height;
  const mine = all.filter((w) => pids.includes(String(w.kCGWindowOwnerPID)) && w.kCGWindowLayer === 0).sort((a, b) => area(b) - area(a));
  return mine.length ? String(mine[0].kCGWindowNumber) : "";
}`;

/**
 * Shoots the app's window as the screen shows it, into `file`; false when it
 * cannot. WebKit's own snapshot (the driver's screenshot) leaves out frames
 * that run in another web process, as every design card does (X64), so a
 * shot of cards needs the OS's.
 */
function shootWindow(file: string): boolean {
  try {
    const pids = execFileSync("pgrep", ["-f", APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]).toString().trim().split("\n");
    const id = execFileSync("osascript", ["-l", "JavaScript", "-e", WINDOW_NUMBER_SCRIPT, ...pids]).toString().trim();
    if (!id) return false;
    execFileSync("screencapture", ["-x", "-o", "-l", id, file], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a screenshot of the element at `target` (an XPath) as
 * `SNAP_DIR/<name>.png` and returns the box of each XPath in `measure`, null
 * for one that is not on the page. The window is shot by macOS
 * `screencapture`, so design cards' frames show (the driver's own screenshot,
 * used when that fails, leaves them blank), and cropped to the target with
 * `sips`; without a target on the page it stays whole.
 */
export async function snap(name: string, target: string, measure: Record<string, string> = {}): Promise<Record<string, Box | null>> {
  mkdirSync(SNAP_DIR, { recursive: true });
  const file = `${SNAP_DIR}/${name}.png`;
  // The window is often in the background, where WebKit holds CSS
  // transitions; give them a moment.
  await browser.pause(300);
  if (!shootWindow(file)) {
    console.warn("snap: macOS could not shoot the window (does the terminal have Screen Recording?); design cards' frames show blank");
    await browser.saveScreenshot(file);
  }
  const crop = await browser.execute((xp: string) => {
    const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
    const r = el?.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return r ? { x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) } : null;
  }, target);
  if (crop) execFileSync("sips", ["-c", String(crop.h), String(crop.w), "--cropOffset", String(crop.y), String(crop.x), file, "--out", file], { stdio: "ignore" });
  return browser.execute((xpaths: Record<string, string>) => {
    const out: Record<string, { left: number; top: number; width: number; height: number } | null> = {};
    for (const [key, xp] of Object.entries(xpaths)) {
      const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
      const r = el?.getBoundingClientRect();
      out[key] = r ? { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 } : null;
    }
    return out;
  }, measure);
}
