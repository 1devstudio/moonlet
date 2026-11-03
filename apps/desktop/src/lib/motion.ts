/** Attributes for a container that stays mounted while hidden, such as a tab
 *  not shown: `styles/motion.css` pauses every animation inside it (X82). */
export const quietWhen = (hidden: boolean): Record<string, string> => (hidden ? { "data-quiet": "" } : {});
