"use client";
// The docs' two bits of behaviour (X85): the install tabs inside a page's
// Markdown, and the Menu button that shows the docs nav on a phone.
import { useEffect } from "react";

export function DocsBehaviour() {
  useEffect(() => {
    const off: Array<() => void> = [];
    const on = (el: Element, fn: () => void) => {
      el.addEventListener("click", fn);
      off.push(() => el.removeEventListener("click", fn));
    };

    document.querySelectorAll(".tabs").forEach((box) => {
      const tabs = box.querySelectorAll<HTMLElement>(".tabs__tab");
      tabs.forEach((tab) =>
        on(tab, () => {
          tabs.forEach((t) => {
            t.classList.toggle("tabs__tab--on", t === tab);
            t.setAttribute("aria-selected", String(t === tab));
          });
          box.querySelectorAll<HTMLElement>(".tabs__panel").forEach((p) => {
            p.hidden = p.dataset.panel !== tab.dataset.tab;
          });
        }),
      );
    });

    const menu = document.querySelector(".menu-button");
    const nav = document.getElementById("docs-nav");
    if (menu && nav)
      on(menu, () => {
        const closed = nav.classList.toggle("docs__nav--closed");
        menu.setAttribute("aria-expanded", String(!closed));
      });

    return () => off.forEach((f) => f());
  }, []);
  return null;
}
