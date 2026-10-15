// Class names for components. A later class wins over an earlier one for the
// same property (`w-full` then `w-[130px]` gives `w-[130px]`), so a caller's
// className can override a component's own. Two classes for one property
// otherwise leave the winner to the order Tailwind writes its CSS in.

import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge<"ui-text">({
  extend: {
    // The app's text sizes (`ui-text-13`), which scale with the UI size.
    classGroups: { "ui-text": [{ "ui-text": [(v: string) => /^\d+(\.\d+)?$/.test(v)] }] },
  },
});

export function cx(...c: (string | false | null | undefined)[]) {
  return merge(c.filter(Boolean).join(" "));
}
