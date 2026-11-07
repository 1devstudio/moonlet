/** Attributes for a container that stays mounted while hidden, such as a tab
 *  not shown: `styles/motion.css` pauses every animation inside it, and
 *  `index.css` hides everything inside it, even what sets itself visible (X82). */
export const quietWhen = (hidden: boolean): Record<string, string> => (hidden ? { "data-quiet": "" } : {});
