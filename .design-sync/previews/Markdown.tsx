import { Markdown } from "@moonlet/ds";

const reply = `The checkout button had a fixed \`width: 420px\`, so it overflowed on phones.

**What changed**

- It now fills its container, capped at 420px.
- Disabled buttons are dimmed instead of hidden.

\`\`\`css
.checkout-button {
  width: 100%;
  max-width: 420px;
}
\`\`\`

| Screen | Before | After |
| --- | --- | --- |
| iPhone SE | overflows | fits |
| Desktop | 420px | 420px |

Shall I also run the visual regression tests?`;

export const AgentReply = () => (
  <div className="bg-bg p-4" style={{ width: 600 }}>
    <Markdown text={reply} />
  </div>
);

export const Headings = () => (
  <div className="bg-bg p-4" style={{ width: 600 }}>
    <Markdown text={"## Plan\n\n1. Reproduce the overflow on a 375px viewport.\n2. Replace the fixed width with `max-width`.\n3. Add a regression test.\n\n> The design system's `Button` already handles focus rings."} />
  </div>
);
