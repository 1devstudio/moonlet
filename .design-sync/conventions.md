# Building with jaunt's design system

jaunt is a dark, dense desktop UI for supervising coding agents. Everything renders on near-black surfaces with one warm accent (`#d97757`); state colors are reserved for agent status.

## Setup

- Plain components (`Button`, `ToolRow`, `PermissionCard`…) need no wrapper.
- The app screens `Sidebar`, `AgentView` and `Composer` read app state. **Always wrap them in `<JauntPreview>`**, which seeds a demo workspace (projects `storefront` and `payments-api`, five sessions, a Claude conversation). Without it they render empty. Use `selected="s-search"` (etc.) to change the highlighted session. `AgentView` shows chat terminal `id={1}` (`wsId="s-checkout"`); pass `chats={{ 1: { status: "blocked", pending: [...] } }}` to vary it.
- Put the screens on a dark surface with a fixed size. Inside a card, `Sidebar` wants about 280×540, and `AgentView` about 760×640.
- Icons come from `icons` (lucide-react): `const { Plus, X, GitBranch } = icons;`, sized 12-16 in rows and 22 in empty states.

## Styling idiom: Tailwind v4 utilities on jaunt's tokens

Use utility classes whose names map to the theme tokens (also available as `var(--color-*)`):

| Role | Classes |
|---|---|
| Surfaces | `bg-bg` (#121212 app background), `bg-panel` (sidebars, cards), `bg-panel-2`, `bg-raised` (inputs, user bubbles), `bg-hover` |
| Text | `text-fg` (primary), `text-muted` (secondary), `text-faint` (hints) |
| Lines | `border border-border`, `border-border-strong` |
| Accent / state | `text-accent`, `text-blocked` (needs input), `text-done`, `text-error`, `text-add`, `text-del`, `text-merged` |
| Type | `font-sans` (Inter / system), `font-mono` (JetBrains Mono, for code, paths, diff stats); sizes are explicit, e.g. `text-[13px]`, `text-[12.5px]`, `text-[11.5px]` |
| Layout | `flex`, `flex-col`, `items-center`, `justify-between`, `gap-1` to `gap-3`, `p-3`, `p-4`, `px-3 py-2`, `rounded-md`, `rounded-xl` |

**Only classes jaunt itself uses exist in the compiled stylesheet.** Arbitrary values that the app does not use (e.g. `w-[280px]`) are not generated. For sizes, use inline `style={{ width: 280, height: 540 }}`.

Form inputs: `className={inputCls}`, wrapped in `Field`. Body text is 13.5px Inter on `bg-bg`.

## Where the truth lives

- `styles.css` (its imports: `_ds_bundle.css` for the compiled utilities and component classes, `fonts/fonts.css`).
- Each component's `.prompt.md` (usage and examples) and `.d.ts` (props).

## Example

```tsx
const { GitPullRequest } = icons;
<div className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-4" style={{ width: 420 }}>
  <div className="flex items-center gap-2 text-[13px] text-fg">
    <StateGlyph state="blocked" /> Add search to the product list
    <span className="ml-auto"><DiffStat add={212} del={30} /></span>
  </div>
  <ToolRow cwd="/repo" tool={{ name: "Bash", summary: "pnpm test", input: {}, status: "ok", output: "42 passed" }} />
  <div className="flex gap-1.5">
    <Button variant="primary"><GitPullRequest size={13} /> Create PR</Button>
    <Button variant="ghost">Archive</Button>
  </div>
</div>
```
