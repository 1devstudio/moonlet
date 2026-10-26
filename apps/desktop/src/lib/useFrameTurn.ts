import { useEffect, useRef, useState } from "react";
import { cardFrames, frameLoader, type FrameStep } from "./frameQueue";

type Seen = { src: string | null; step: FrameStep };

/** A frame's loads of `url` through the card frames' queue (X64), while
 *  `live`: the address to give the frame (null until its first turn), where
 *  it is, and what to call once it loaded (`frameLoader`). */
export function useFrameTurn(url: string, live: boolean): Seen & { loaded: () => void } {
  const [seen, setSeen] = useState<Seen>({ src: null, step: "waiting" });
  const loader = useRef<ReturnType<typeof frameLoader> | null>(null);
  useEffect(() => {
    if (!live) return;
    const mine = frameLoader(cardFrames, setSeen);
    loader.current = mine;
    return () => {
      mine.stop();
      loader.current = null;
      setSeen({ src: null, step: "waiting" });
    };
  }, [live]);
  useEffect(() => {
    if (live) loader.current?.load(url);
  }, [url, live]);
  return { ...seen, loaded: () => loader.current?.loaded() };
}
