import { type RefObject, useEffect, useState } from "react";

/** The attribute that marks the scrolling element design cards' frames are near or far in. */
export const NEAR_ROOT = "data-near-root";

/**
 * Whether the element is on screen or within one screen of it, in the nearest
 * ancestor marked with {@link NEAR_ROOT} (else the window), kept current as
 * it scrolls. Each design card's frame is its own web process (X64), so a
 * card is framed only while this holds, and let go once it no longer does.
 */
export function useNear(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), {
      root: el.closest(`[${NEAR_ROOT}]`),
      rootMargin: "100% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}
