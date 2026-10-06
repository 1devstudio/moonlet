// The pixel scene a sidebar row plays while its session archives (X21).

export const LOADERS = ["Gravedigger", "Ghost", "Zombie wave", "Graveyard progress", "Reaper"] as const;
export type Loader = (typeof LOADERS)[number];

/** Frames drawn per second, and frames in one loop of a scene. */
export const LOADER_FPS = 12;
export const LOADER_CYCLE = 72;
/** A row plays its scene at least this long, so a fast archive still shows it. */
export const ARCHIVE_MIN_MS = (LOADER_CYCLE / LOADER_FPS) * 1000;
/** How long the row takes to fold away afterwards. */
export const ARCHIVE_FOLD_MS = 280;

export interface Archiving {
  loader: Loader;
  /** The daemon has archived the session; the scene still plays out. */
  done: boolean;
  folding: boolean;
}

export function pickLoader(random: () => number = Math.random): Loader {
  return LOADERS[Math.min(LOADERS.length - 1, Math.floor(random() * LOADERS.length))];
}
