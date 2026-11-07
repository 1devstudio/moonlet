# X82 — Nothing moves where nobody looks

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** performance targets in `docs/plan.md`; follows X78
- **Related ADRs:** none

## Summary

With the app idle, the window server used about 70% of a core. The app keeps
endless CSS animations running: spinners, the working dots in the sidebar and
in tabs, pulsing job and agent dots, indeterminate progress bars, and the
chat's "Working" shimmer. Tabs that are not shown stay mounted under
`visibility: hidden`, so their animations keep running although nobody sees
them. The shimmer animates `background-position` of text clipped to its
background, which the compositor cannot move: WebKit paints it again on every
frame. The agents strip above the chat input, and the right panel behind
another of its tabs, re-render every second while agents run, though the
clock they show cannot be seen. This spec stops animations and tickers where
they cannot be seen, makes the shimmer a compositor-only animation, and honours
the system's reduced-motion setting.

## User journey

1. The user keeps several sessions open, each with a few tabs, and agents
   working in some of them.
2. Only the session and tab on screen animate. Tabs behind it are still.
3. The user switches to another tab: its spinners and dots move again from
   where they stopped.
4. With "Reduce motion" on in macOS, nothing in the app animates endlessly.

## Behaviour and acceptance criteria

- [x] Animations inside a tab that is not shown are paused, and run again once
      the tab is shown (`pauses an animation inside a hidden tab`,
      `keeps an animation in the shown tab running`).
- [x] Nothing inside a tab that is not shown is seen or takes clicks, even
      what marks itself visible, such as the diff editor's two sides
      (`hides a pane that sets itself visible inside a hidden tab`,
      `keeps a pane that sets itself visible shown in the shown tab`;
      `file-explorer.e2e.ts` › "hides the diff when the session's terminal tab
      is shown again").
- [x] Every endless animation moves only opacity and transform, which the
      compositor animates without painting; the chat's shimmer is one of them,
      and so are Tailwind's `animate-*` classes the app uses
      (`animates only opacity and transform in every endless animation`).
- [x] The agents strip's clock ticks only while agents run and its tab is shown
      (`ticks the strip's clock only while agents run and the strip is shown`).
- [x] The right panel's agents clock ticks only while agents run and its
      Agents tab is shown
      (`ticks the Agents tab's clock only while agents run and the tab is shown`).
- [x] A clock that stopped while its tab was hidden shows the time at once
      when the tab is shown again, not the time it stopped at
      (`reads the time at once when its clock starts again`).
- [x] With reduced motion asked for, no animation repeats: each runs once
      (`runs an endless animation once when the system asks for reduced motion`).
- [x] With reduced motion asked for, a progress bar without a percentage
      stands still as stripes across its whole track, so it never reads as a
      bar stopped part way
      (`shows a progress bar without a percentage as a still, striped bar across the track when the system asks for reduced motion`).

## UI

The shimmer on "Working", "Thinking…" and "Answering from the conversation"
becomes a brightening of the whole label, from the muted grey to the light grey
the sweep peaked at, and back. It no longer sweeps from left to right. Nothing
else looks different while a tab is shown.

With "Reduce motion" on, a progress bar without a percentage no longer sweeps:
accent stripes fill its whole track and stand still. Run once and stopped, the
sweep would leave its segment over the track's left 40%, which reads as 40%
done.

## Protocol and RPCs

None.

## Data and config

None.

## Security considerations

None: no new inputs.

## Out of scope

- A hidden or minimised window, or one fully covered by others: WebKit already
  suspends a hidden page's CSS animations and the app adds nothing.
- A window that is shown but not focused keeps animating: the user may watch
  an agent work from another app.
- The X78 leftovers (live terminals of sessions not shown, unvirtualized
  transcripts, `App` reading the whole store).

## Test plan

- Vitest, `motion.test.ts`: `pauses an animation inside a hidden tab`,
  `keeps an animation in the shown tab running`,
  `animates only opacity and transform in every endless animation`,
  `runs an endless animation once when the system asks for reduced motion`,
  `hides a pane that sets itself visible inside a hidden tab`,
  `keeps a pane that sets itself visible shown in the shown tab` and
  `shows a progress bar without a percentage as a still, striped bar across the track when the system asks for reduced motion`.
  The endless-animation test builds the app's stylesheet with Tailwind from
  `index.css` and every file it imports, with the `animate-*` classes found in
  the app's sources, and reads the `animation` shorthand, its longhands and
  rules nested in `@media`, `@supports` and `@layer`. The pause and
  reduced-motion rules name `::before` and `::after` in the same selector list
  as the elements; jsdom drops a list holding a pseudo-element, so the tests
  give it each selector as a rule of its own, and cannot check the
  pseudo-elements themselves (jsdom computes no style for them). The progress
  bar's test reads the app's stylesheet with the reduced-motion rules as
  `@media screen` ones (the only media jsdom applies) and a child element
  standing in for the bar's `::after`.
- The hiding rule wins over Monaco's inline `visibility: visible` by
  `!important`, which jsdom ignores: its tests give the pane a stylesheet rule
  placed before the app's, and the e2e checks Monaco's own in WebKit.
- e2e, `file-explorer.e2e.ts`: "hides the diff when the session's terminal tab
  is shown again".
- Vitest, `subagents.test.ts`: `ticks the strip's clock only while agents run
  and the strip is shown` and `ticks the Agents tab's clock only while agents
  run and the tab is shown`.
- Vitest, `useNow.test.ts`: `reads the time at once when its clock starts
  again`.
- Manual, in the e2e app with `e2e/snap.ts`: the new shimmer at rest matches
  the old muted label and at its peak the old sweep's light grey; the app's
  WebKit reports `document.getAnimations()` inside a `data-quiet` tab as
  `paused` and the shown ones as `running`, `::after` (the progress bar) and
  `::before` animations too. With the reduced-motion rules applied outside
  their `@media`, every one of those animations, pseudo-elements too, runs
  once. The system setting itself is untried (it was off).

## Open questions

- Should animations also pause while the window is shown but not focused?
