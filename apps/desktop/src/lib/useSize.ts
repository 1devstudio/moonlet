import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** The inner size an element has, kept up to date. */
export function useSize<T extends HTMLElement>(): [RefObject<T | null>, [number, number]] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize([el.clientWidth, el.clientHeight]);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
