// Pixel-art night scene a sidebar row plays while its session archives (X21).
// Ported from the design's "Archive Loader Options": each scene is drawn in
// an 80 × 19 pixel space on the right of a half-resolution canvas, scaled 2×.

import { useEffect, useRef } from "react";
import { LOADER_CYCLE, LOADER_FPS, type Loader } from "../lib/archiveLoader";

/** Canvas height in pixels, ground line, scene width. */
const H = 19;
const G = 17;
const SCENE_W = 77;
const STEP = 18;

const FONT: Record<string, string[]> = {
  R: ["110", "101", "110", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  P: ["110", "101", "110", "100", "100"],
  B: ["110", "101", "110", "101", "110"],
  Y: ["101", "101", "010", "010", "010"],
  E: ["111", "100", "110", "100", "111"],
  "!": ["1", "1", "1", "0", "1"],
};
const K = {
  sky: "#161616", ground: "#1c1c1c", groundTop: "#2e2e2e", grass: "#3d5a3a", hole: "#070707", dirt: "#5b3f2e", dirtLight: "#7a5640",
  stone: "#7d7d7d", stoneLight: "#a3a3a3", stoneDark: "#4a4a4a", wood: "#8a6a4a", skin: "#e8c4a0", pants: "#3a4a6a", accent: "#d97757",
  fg: "#e6e6e6", done: "#6fbf73", ghost: "#ececec", cloak: "#3a3a3a", void: "#050505", blade: "#d9d9d9", bone: "#e6e0d0", border: "#3a3a3a",
  winBg: "#1a1a1a", winBar: "#2a2a2a", star: "#444", starOn: "#9a9a9a",
};
const STARS = [[6, 6], [19, 11], [33, 4], [52, 9], [67, 5], [74, 15], [44, 16], [11, 20], [60, 19]];
const GHOST = [
  ["..ggg..", ".ggggg.", "ggegegg", "ggggggg", "gggeggg", "ggggggg", "g.ggg.g"],
  ["..ggg..", ".ggggg.", "ggegegg", "ggggggg", "gggeggg", "ggggggg", ".ggg.gg"],
];
const REAPER = ["...ccc...", "..ccccc..", ".cckkkcc.", ".ckakakc.", ".cckkkcc.", ".ccccccc.", "ccccccccc", "ccccccccc", "ccccccccc", "ccccccccc", ".ccccccc.", ".ccccccc."];
const REAPER_HEM = ["c.c.c.c.c", ".c.c.c.c."];

interface Particle { x: number; y: number; vx: number; vy: number; c: string; life: number; g?: number; free?: boolean }
interface SceneState { parts: Particle[] }

// The canvas being drawn and its width; scene x = 0 sits at `OX`.
let C: CanvasRenderingContext2D;
let W = 150;
let OX = 73;

const px = (x: number, y: number, w: number, h: number, col: string) => {
  C.fillStyle = col;
  C.fillRect(Math.round(x), Math.round(y), w, h);
};
function text(s: string, x: number, y: number, col: string) {
  for (const ch of s) {
    const g = FONT[ch];
    if (!g) { x += 2; continue; }
    g.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === "1") px(x + i, y + j, 1, 1, col); });
    x += g[0].length + 1;
  }
}
function line(x0: number, y0: number, x1: number, y1: number, col: string) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (let n = 0; n < 200; n++) {
    px(x0, y0, 1, 1, col);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
function spr(rows: string[], x: number, y: number, map: Record<string, string>) {
  rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) { const col = map[r[i]]; if (col) px(x + i, y + j, 1, 1, col); } });
}
function clipSky(fn: () => void) { C.save(); C.beginPath(); C.rect(-OX, 0, W, G); C.clip(); fn(); C.restore(); }
function base(t: number) {
  px(-OX, 0, W, H, K.sky);
  STARS.forEach(([x, y], i) => px(Math.round((x * W) / 80 - OX), Math.round((y * (G - 4)) / 38), 1, 1, (t + i * 5) % 20 < 14 ? K.star : K.starOn));
  px(-OX, G, W, H - G, K.ground); px(-OX, G, W, 1, K.groundTop);
  [[3, 1], [15, 2], [27, 1], [63, 2], [76, 1]].forEach(([x, h]) => px(Math.round((x * W) / 80 - OX), G - h, 1, h, K.grass));
}
function tomb(x: number, y: number, h = 14) {
  const w = 13;
  px(x + 2, y, w - 4, 1, K.stone); px(x + 1, y + 1, w - 2, 1, K.stone); px(x, y + 2, w, h - 2, K.stone);
  px(x, y + 2, 1, h - 2, K.stoneLight); px(x + 2, y, 2, 1, K.stoneLight);
  px(x + w - 1, y + 2, 1, h - 2, K.stoneDark);
  text("RIP", x + 1, y + 4, K.stoneDark);
}
function win(x: number, y: number, t: number, w = 20, h = 14) {
  px(x, y, w, h, K.border); px(x + 1, y + 1, w - 2, h - 2, K.winBg); px(x + 1, y + 1, w - 2, 2, K.winBar);
  px(x + 2, y + 1, 1, 1, K.accent); px(x + 4, y + 1, 1, 1, K.stoneDark); px(x + 6, y + 1, 1, 1, K.stoneDark);
  px(x + 3, y + 5, 1, 1, K.accent); px(x + 4, y + 6, 1, 1, K.accent); px(x + 3, y + 7, 1, 1, K.accent);
  if (t % 8 < 4) px(x + 6, y + 7, 2, 1, K.fg);
  px(x + 3, y + 10, 11, 1, K.stoneDark);
}
function particles(S: SceneState) {
  S.parts = S.parts.filter((p) => p.life > 0);
  S.parts.forEach((p) => {
    p.x += p.vx; p.y += p.vy; p.vy += p.g ?? 0.25; p.life--;
    if (p.y >= G - 1 && p.vy > 0 && !p.free) { p.y = G - 1; p.vx = 0; p.vy = 0; }
    px(p.x, p.y, 1, 1, p.c);
  });
}
const spawn = (S: SceneState, n: number, f: (i: number) => Particle) => { for (let i = 0; i < n; i++) S.parts.push(f(i)); };
const R = (a: number, b: number) => a + Math.random() * (b - a);

function digger(x: number, y: number, f: number) {
  px(x, y - 1, 5, 1, K.stoneDark); px(x + 1, y - 2, 3, 1, K.stoneDark);
  px(x + 1, y, 3, 3, K.skin); px(x + 3, y + 1, 1, 1, K.sky);
  px(x + 1, y + 3, 3, 4, K.accent);
  px(x + 1, y + 7, 1, 4, K.pants); px(x + 3, y + 7, 1, 4, K.pants);
  if (f === 0) { line(x + 5, y + 3, x + 10, y + 9, K.wood); px(x + 10, y + 9, 2, 2, K.stoneLight); line(x + 4, y + 4, x + 6, y + 5, K.skin); }
  else if (f === 1) { line(x + 4, y + 6, x + 9, y, K.wood); px(x + 9, y - 1, 2, 2, K.stoneLight); px(x + 9, y - 2, 2, 1, K.dirtLight); line(x + 4, y + 4, x + 6, y + 2, K.skin); }
  else { line(x + 6, y + 1, x + 6, y + 10, K.wood); px(x + 5, y + 10, 3, 1, K.stoneLight); px(x + 4, y + 4, 2, 1, K.skin); }
}

const SCENES: Record<Loader, (t: number, S: SceneState) => void> = {
  // A little worker digs the hole, a headstone pops up and he leans on his shovel.
  Gravedigger(t, S) {
    const p = t % LOADER_CYCLE;
    base(t);
    const depth = Math.min(4, Math.floor(p / 8));
    px(34, G, 12, depth + 1, K.hole);
    const mh = Math.min(6, Math.floor(p / 7));
    for (let r = 0; r < mh; r++) { const half = mh - r + 1; px(58 - half, G - 1 - r, half * 2, 1, r === mh - 1 ? K.dirtLight : K.dirt); }
    if (p >= 54) { const rise = Math.min(14, (p - 54) * 2); clipSky(() => tomb(34, G - rise)); }
    const f = p < 54 ? Math.floor(p / 4) % 2 : 2;
    digger(22, G - 12, f);
    if (p < 54 && p % 8 === 4) spawn(S, 3, () => ({ x: 31 + R(0, 2), y: G - 14, vx: R(1.2, 2.2), vy: R(-1.8, -0.8), c: Math.random() < 0.5 ? K.dirt : K.dirtLight, life: 26 }));
    if (p >= 62 && p < 70) text("!", 24, G - 21, K.accent);
    particles(S);
  },
  // The terminal sinks into the ground, a headstone takes its place and a ghost floats off.
  Ghost(t, S) {
    const p = t % LOADER_CYCLE;
    base(t);
    if (p < 32) { const y = p < 16 ? G - 16 : G - 16 + (p - 16) * 1.1; clipSky(() => win(30, y, t)); }
    if (p >= 16 && p < 32 && p % 3 === 0) spawn(S, 2, () => ({ x: R(30, 50), y: G - 1, vx: R(-0.6, 0.6), vy: R(-1.4, -0.6), c: K.stoneDark, life: 10, g: 0.15 }));
    if (p >= 30) { const rise = Math.min(14, (p - 30) * 3); clipSky(() => tomb(33, G - rise)); }
    if (p >= 36 && p < 70) {
      const q = p - 36, gy = G - 10 - q * 1.15, gx = 36 + Math.sin(q / 3) * 4;
      C.save(); C.globalAlpha = gy < 6 ? Math.max(0, gy / 6) : 1;
      spr(GHOST[Math.floor(p / 3) % 2], gx, gy, { g: K.ghost, e: K.sky });
      C.restore();
    }
    particles(S);
  },
  // A green hand pushes out of the fresh grave, waves BYE! and sinks back down.
  "Zombie wave"(t, S) {
    const p = t % LOADER_CYCLE;
    base(t);
    tomb(52, G - 14);
    let ah = 0;
    if (p >= 8 && p < 16) ah = p - 8; else if (p >= 16 && p < 52) ah = 8; else if (p >= 52 && p < 60) ah = 60 - p;
    const top = G - 3 - ah;
    if (ah > 0) {
      px(31, top, 3, ah, K.done);
      if (ah >= 3) {
        px(30, top - 3, 5, 3, K.done);
        const wv = p >= 16 && p < 52 ? Math.floor(p / 4) % 2 : 0;
        [30, 32, 34].forEach((x) => px(x + wv, top - 5, 1, 2, K.done));
        px(29, top - 2, 1, 1, K.done);
        px(31, top + 2, 3, 1, K.stoneDark);
      }
    }
    px(18, G - 2, 30, 2, K.dirt); px(21, G - 3, 24, 1, K.dirtLight);
    if (p < 10 && p % 2 === 0) spawn(S, 2, () => ({ x: R(28, 36), y: G - 4, vx: R(-0.8, 0.8), vy: R(-1.6, -0.8), c: K.dirtLight, life: 10 }));
    if (p >= 20 && p < 50) {
      const by = Math.max(1, G - 28);
      px(38, by + 1, 17, 9, K.fg); px(39, by, 15, 1, K.fg); px(39, by + 10, 15, 1, K.fg);
      px(37, by + 11, 2, 1, K.fg); px(36, by + 12, 1, 1, K.fg);
      text("BYE!", 40, by + 3, K.sky);
    }
    particles(S);
  },
  // One headstone drops per archive step, with flowers at the end.
  "Graveyard progress"(t, S) {
    const p = t % LOADER_CYCLE;
    base(t);
    [9, 33, 57].forEach((x, i) => {
      const q = p - i * STEP;
      if (q < 0) { px(x + 2, G - 1, 9, 1, K.groundTop); return; }
      if (q < 8) {
        const k = q / 7, y = -14 + (G - 14 + 14) * k * k, s = Math.round(1 + 5 * k);
        px(x + 6 - s, G, s * 2 + 1, 1, K.hole);
        clipSky(() => tomb(x, Math.min(y, G - 14)));
        if (q === 7) spawn(S, 8, (j) => ({ x: x + (j < 4 ? -1 : 13), y: G - 1, vx: (j < 4 ? -1 : 1) * R(0.4, 1.2), vy: R(-1.4, -0.4), c: K.stoneDark, life: 9, g: 0.12 }));
      } else if (q === 8) tomb(x - 1, G - 13, 13);
      else tomb(x, G - 14);
      if (p >= 56) {
        const h = Math.min(3, Math.floor((p - 56) / 2));
        if (h > 0) { px(x + 6, G - h, 1, h, K.grass); if (h === 3) { px(x + 5, G - 4, 3, 1, K.accent); px(x + 6, G - 5, 1, 1, K.accent); px(x + 6, G - 4, 1, 1, K.fg); } }
      }
    });
    particles(S);
  },
  // The grim reaper drifts over, slices the terminal in half and floats back.
  Reaper(t, S) {
    const p = t % LOADER_CYCLE;
    base(t);
    let rx: number;
    if (p < 26) rx = 6 + p * 0.77; else if (p < 54) rx = 26; else rx = 26 - (p - 54) * 1.1;
    const ry = G - 14 + (Math.floor(p / 6) % 2);
    const WX = 46, WY = G - 16;
    if (p < 30) win(WX, WY, t);
    else if (p < 56) {
      const o = p - 30, a = Math.max(0, 1 - o / 22);
      ([[-1, WX], [1, WX + 10]] as const).forEach(([d, cx]) => {
        C.save(); C.globalAlpha = a;
        C.translate(Math.round(d * o * 0.5), Math.round(o * o * 0.05));
        C.beginPath(); C.rect(cx, WY, 10, 14); C.clip();
        win(WX, WY, t);
        C.restore();
      });
    } else if (p >= 60) { C.save(); C.globalAlpha = (p - 60) / 12; win(WX, WY, t); C.restore(); }
    if (p === 30) spawn(S, 14, () => ({ x: WX + 10, y: WY + R(0, 14), vx: R(-1.2, 1.2), vy: R(-1.6, 0.2), c: Math.random() < 0.5 ? K.accent : K.fg, life: 18, free: true, g: 0.12 }));
    px(rx + 1, G, 7, 1, "#0c0c0c");
    spr(REAPER, rx, ry, { c: K.cloak, k: K.void, a: K.accent });
    spr([REAPER_HEM[Math.floor(p / 3) % 2]], rx, ry + 12, { c: K.cloak });
    if (p >= 27 && p < 40) {
      if (p < 31) line(rx + 12, ry - 4, rx + 22, ry + 3, K.stoneDark);
      line(rx + 4, ry + 3, rx + 14, ry + 10, K.wood);
      line(rx + 14, ry + 10, rx + 20, ry + 5, K.blade); px(rx + 21, ry + 5, 1, 1, K.blade); px(rx + 22, ry + 6, 1, 1, K.blade);
      px(rx + 7, ry + 6, 2, 1, K.bone);
    } else {
      line(rx + 9, ry - 2, rx + 9, ry + 13, K.wood);
      px(rx + 3, ry - 3, 7, 1, K.blade); px(rx + 1, ry - 2, 2, 1, K.blade); px(rx, ry - 1, 1, 1, K.blade);
      px(rx + 8, ry + 6, 2, 1, K.bone);
    }
    particles(S);
  },
};

/** Takes the sky (the sidebar panel), accent, foreground and done colours from the theme. */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const [k, v] of [["sky", "--color-panel"], ["accent", "--color-accent"], ["fg", "--color-fg"], ["done", "--color-done"]] as const) {
    const c = cs.getPropertyValue(v).trim();
    if (c) K[k] = c;
  }
}

/** Fills its row; the scene plays on the right half, at half resolution. */
export function ArchiveLoader({ loader }: { loader: Loader }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    themeColors();
    const S: SceneState = { parts: [] };
    let t = 0;
    const draw = () => {
      const w = Math.max(SCENE_W, Math.round(el.clientWidth / 2));
      if (el.width !== w) el.width = w;
      if (t % LOADER_CYCLE === 0) S.parts = [];
      C = ctx;
      W = w;
      OX = w - SCENE_W;
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1, 0, 0, 1, OX, 0);
      SCENES[loader](t++, S);
    };
    draw();
    const timer = setInterval(draw, 1000 / LOADER_FPS);
    return () => clearInterval(timer);
  }, [loader]);
  return <canvas ref={ref} width={150} height={H} aria-hidden className="pointer-events-none absolute inset-0 block h-full w-full" style={{ imageRendering: "pixelated" }} />;
}
