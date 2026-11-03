# X81 — Transcripts and job output stay bounded

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** performance targets in `docs/plan.md` (memory under 600 MB with 10 panes); X6 structured chats, X62 jobs
- **Related ADRs:** none

## Summary

The app's web content process grew to 1.5–1.9 GB in a day. Most of it was
chat transcripts and job output: the app loaded every chat's whole transcript
on every connect and kept each one until its tab closed, rendered every block
of a shown chat, found each Interrupted divider by searching the transcript
again, and kept and re-read every byte a job printed each time more came.
This spec keeps in memory only the transcripts of chats shown lately, renders
the end of a long transcript, and keeps the end of a job's output.

## User journey

1. The user keeps many sessions with long chats open and leaves the app
   running for days.
2. They switch between a few chats. Each shows its conversation as before;
   one not shown for a while shows "Loading conversation…" for a moment, then
   its conversation.
3. A chat with a long history opens at its end. "Show earlier" above the first
   block shows more of it.
4. A job prints a lot of output. Its view shows the end of it, numbered as
   before, under "Earlier output trimmed".

## Behaviour and acceptance criteria

- [ ] The app loads a chat's transcript when the chat is shown, not every
      chat's when it connects. On reconnect it reloads only the chats already
      in memory.
- [ ] The transcripts of the last 8 chats shown stay in memory. A chat that
      falls out of them drops its transcript, and loads it again from the
      daemon (`chat.state`) when it is shown again.
- [ ] A chat without its transcript in memory keeps its status, asks and
      subagents, kept current by `chat.state` events, so the Agents and Plan
      panels show them without loading the transcript. A chat loaded only for
      them (not shown) keeps nothing more.
- [ ] A chat renders its last 200 blocks. "Show earlier" shows 200 more each
      time it is clicked.
- [ ] Each Interrupted divider is found in one pass over the transcript, not
      by searching it once per divider. The dividers are the same as before.
- [ ] A streamed item replaces its earlier version by id as before; held
      events replayed after a load are applied together.
- [ ] A job's view keeps at most the last 1 MiB of its output (counted in
      characters, a newline included), dropping whole lines from the start,
      and says "Earlier output trimmed" above what it keeps. Lines keep the
      numbers they had.
- [ ] A job's output is read chunk by chunk as it arrives: only the new
      chunks are parsed, and a line or colour code cut between chunks reads
      as before.

## UI

- Chat: a "Show earlier" button above the first block shown, only when
  earlier blocks are hidden. Notes placed before the first block show only
  once every block is shown.
- Job tab and the Jobs panel's job detail: a faint "Earlier output trimmed"
  line above the output when some was dropped. **Copy output** copies what is
  kept.

## Protocol and RPCs

None. `chat.state` and `job.output` are read as before.

## Data and config

None persisted.

## Security considerations

None: no new inputs.

## Out of scope

- Terminals of sessions not shown keep a live xterm (X78's out of scope).
- A job view renders every kept line; with 1 MiB kept, that is bounded, not
  virtualized.
- "Show in chat" from a design comment scrolls to a card only among the
  blocks shown.

## Test plan

- Vitest, `chatMemory.test.ts`: `keeps the items of the last 8 chats shown and
  drops the others'`, `loads a dropped chat's items again when it is shown
  again`, `keeps a dropped chat's status and asks current, without its
  items`, `keeps only the status and asks of a chat loaded but not shown` and
  `reloads on connect only the chats already in memory`.
- Vitest, `chat.test.ts`: `shows the last 200 blocks and counts the earlier
  ones` and `applies events held during a load in order, the latest version
  of an item winning`.
- Vitest, `queued.test.ts`: `marks each Interrupted that stopped a command,
  across the whole transcript`.
- Vitest, `jobs.test.ts`: `keeps the end of a long output, numbered as it
  was, and says earlier output was trimmed` and `reads output chunk by chunk
  as it comes, joining a line and a colour code cut between chunks`.
- Vitest, `jobsStore.test.ts`: `keeps at most 1 MiB of a job's output,
  however much it printed`.
- Vitest: existing `chat.test.ts`, `jobs.test.ts`, `jobsStore.test.ts`,
  `plan.test.ts` and `subagents.test.ts` stay green.
- Manual: `footprint` of the app's web content process with the user's
  sessions loaded, before and after a day of use.

## Open questions

- None.
