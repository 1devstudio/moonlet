// Sounds played when an agent finishes, fails or needs the user (X8).

/** macOS system sounds. Must match `SOUNDS` in src-tauri/src/lib.rs. */
export const SYSTEM_SOUNDS = [
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const;

export type SoundEvent = "blocked" | "done" | "error";

/** Sound name per event; `""` means off. */
export type SoundSettings = Record<SoundEvent, string>;

export const DEFAULT_SOUNDS: SoundSettings = { blocked: "Glass", done: "Hero", error: "Basso" };

export const SOUND_EVENTS: { id: SoundEvent; label: string }[] = [
  { id: "blocked", label: "Needs you" },
  { id: "done", label: "Done" },
  { id: "error", label: "Failed" },
];

/** The sound to play for an agent state, or null for none. Unknown stored values read as the default. */
export function soundFor(sounds: Partial<SoundSettings> | undefined, state: string): string | null {
  if (state !== "blocked" && state !== "done" && state !== "error") return null;
  const v = sounds?.[state];
  if (v === "") return null;
  return v && (SYSTEM_SOUNDS as readonly string[]).includes(v) ? v : DEFAULT_SOUNDS[state];
}
