// The card frames' loading queue (X64): one frame loads at a time. With
// WebKit's site isolation, frames on hosts of their own that start loading
// together are sent one frame's request, so the others never load or show
// another card; one at a time, each loads its own in about 100 ms.

/** Where a frame is: waiting for its turn, loading, or shown. */
export type FrameStep = "waiting" | "loading" | "shown";

/** A frame's place in the queue: it says when it loaded, or lets go. */
export interface FrameTurn {
  loaded(): void;
  leave(): void;
}

interface Entry {
  tell: (step: FrameStep) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A queue that lets one frame load at a time: the next once the one
 *  loading says it loaded, or after `fallbackMs`, when that one is shown
 *  anyway (a card that never stops running may never say it loaded). */
export function frameQueue(fallbackMs: number) {
  const waiting: Entry[] = [];
  let loading: Entry | null = null;

  const next = () => {
    loading = waiting.shift() ?? null;
    if (!loading) return;
    const entry = loading;
    entry.timer = setTimeout(() => done(entry), fallbackMs);
    entry.tell("loading");
  };
  const done = (entry: Entry) => {
    if (loading !== entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.tell("shown");
    next();
  };

  return {
    join(tell: (step: FrameStep) => void): FrameTurn {
      const entry: Entry = { tell, timer: null };
      waiting.push(entry);
      tell("waiting");
      if (!loading) next();
      return {
        loaded: () => done(entry),
        leave: () => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          if (loading === entry) {
            if (entry.timer) clearTimeout(entry.timer);
            next();
          }
        },
      };
    },
  };
}

export type FrameQueue = ReturnType<typeof frameQueue>;

/** One frame's loads through `queue`: the address to give it and where it
 *  is, told to `onChange`. A new address waits for a turn of its own, and
 *  never for the end of one that is waiting: it takes that one's place. A
 *  frame is never sent to a new address while it loads, which WebKit may
 *  leave unloaded; the new one waits until that load is done. A load the
 *  frame reports while none of its turns is loading (its empty first one)
 *  is none of its own. */
export function frameLoader(queue: FrameQueue, onChange: (s: { src: string | null; step: FrameStep }) => void) {
  type Mine = { turn: FrameTurn | null };
  let src: string | null = null;
  let step: FrameStep = "waiting";
  let latest: Mine | null = null;
  let loading: Mine | null = null;
  return {
    load(url: string) {
      if (latest && latest !== loading) latest.turn?.leave();
      const mine: Mine = { turn: null };
      latest = mine;
      mine.turn = queue.join((next) => {
        if (next === "loading") {
          loading = mine;
          src = url;
        } else if (next === "shown" && loading === mine) loading = null;
        if (latest === mine) step = next;
        onChange({ src, step });
      });
    },
    loaded() {
      loading?.turn?.loaded();
    },
    stop() {
      latest?.turn?.leave();
      if (loading !== latest) loading?.turn?.leave();
      latest = loading = null;
    },
  };
}

/** The queue every card and page frame of the app's window loads through. */
export const cardFrames = frameQueue(1000);
