# X82 — Nothing moves where nobody looks

- **Status:** draft
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
frame. The agents strip above the chat input re-renders every second while
agents run, even in a hidden tab. This spec stops animations and tickers where
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

- [ ] Animations inside a tab that is not shown are paused, and run again once
      the tab is shown (`pauses an animation inside a hidden tab`,
      `keeps an animation in the shown tab running`).
- [ ] Every endless animation moves only opacity and transform, which the
      compositor animates without painting; the chat's shimmer is one of them
      (`animates only opacity and transform in every endless animation`).
- [ ] The agents strip's clock ticks only while agents run and its tab is shown
      (`ticks the strip's clock only while agents run and the strip is shown`).
- [ ] With reduced motion asked for, no animation repeats: each runs once
      (`runs an endless animation once when the system asks for reduced motion`).

## UI

The shimmer on "Working", "Thinking…" and "Answering from the conversation"
becomes a brightening of the whole label, from the muted grey to the light grey
the sweep peaked at, and back. It no longer sweeps from left to right. Nothing
else looks different while a tab is shown.

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
  `animates only opacity and transform in every endless animation` and
  `runs an endless animation once when the system asks for reduced motion`.
- Vitest, `subagents.test.ts`: `ticks the strip's clock only while agents run
  and the strip is shown`.
- Manual: the shimmer in the real app, screenshot with `e2e/snap.ts`.

## Open questions

- Should animations also pause while the window is shown but not focused?
