"use client";
// The docs' behaviour (X85): the install tabs inside a page's Markdown, the
// Menu button that shows the docs nav on a phone, and the "On this page" entry
// of the section being read.
import { useEffect } from "react";

export function DocsBehaviour() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const onClick = (el: Element, fn: () => void) => {
      el.addEventListener("click", fn);
      cleanups.push(() => el.removeEventListener("click", fn));
    };

    document.querySelectorAll(".tabs").forEach((box) => {
      const tabs = box.querySelectorAll<HTMLElement>(".tabs__tab");
      tabs.forEach((tab) =>
        onClick(tab, () => {
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
      onClick(menu, () => {
        const closed = nav.classList.toggle("docs__nav--closed");
        menu.setAttribute("aria-expanded", String(!closed));
      });

    // The section being read is the last heading that has scrolled past the top bar.
    const headings = [...document.querySelectorAll<HTMLElement>(".doc-prose h2[id], .doc-prose h3[id]")];
    const items = new Map(
      [...document.querySelectorAll<HTMLAnchorElement>(".toc__item a")].map((a) => [a.hash.slice(1), a.parentElement!]),
    );
    const markReading = () => {
      const below = 96; // the sticky top bar, and a little more
      let reading = headings[0]?.id;
      for (const h of headings) if (h.getBoundingClientRect().top <= below) reading = h.id;
      // At the bottom, the last headings can never reach the top: the last one is being read.
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom && headings.length > 0) reading = headings[headings.length - 1].id;
      items.forEach((li, id) => li.classList.toggle("toc__item--on", id === reading));
    };
    markReading();
    window.addEventListener("scroll", markReading, { passive: true });
    cleanups.push(() => window.removeEventListener("scroll", markReading));

    return () => cleanups.forEach((f) => f());
  }, []);
  return null;
}
