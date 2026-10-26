import { useEffect, useRef, useState } from "react";
import { cardFrames, frameLoader, type FrameLoader, type FrameView } from "./frameQueue";

const WAITING: FrameView = { src: null, step: "waiting" };

/** A frame's loads of `url` through the card frames' queue (X64), while
 *  `live`: the address to give the frame (null until its first turn), where
 *  it is, and what to call once it loaded (`frameLoader`). */
export function useFrameTurn(url: string, live: boolean): FrameView & { loaded: () => void } {
  const [view, setView] = useState<FrameView>(WAITING);
  const loader = useRef<FrameLoader | null>(null);
  useEffect(() => {
    if (!live) return;
    loader.current ??= frameLoader(cardFrames, setView);
    loader.current.load(url);
  }, [url, live]);
  // Let go of its turns once the frame is not live, or gone.
  useEffect(() => {
    if (!live) return;
    return () => {
      loader.current?.stop();
      loader.current = null;
      setView(WAITING);
    };
  }, [live]);
  return { ...view, loaded: () => loader.current?.loaded() };
}
