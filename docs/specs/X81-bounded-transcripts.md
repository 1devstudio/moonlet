# X81 — Transcripts and job output stay bounded

- **Status:** implemented
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

- [x] The app loads a chat's transcript when the chat is shown (a visible
      chat tab, the Plan panel's chat, a new chat's context chips, a design
      system's syncing agent), not every chat's when it connects. On reconnect
      it reloads only the chats already in memory
      (`reloads on connect only the chats already in memory`).
- [x] The transcripts of the last 8 chats shown stay in memory, on the
      desktop and the phone. A chat that falls out of them drops its
      transcript, and loads it again from the daemon (`chat.state`) when it
      is shown again
      (`keeps the items of the last 8 chats shown and drops the others'`,
      `loads a dropped chat's items again when it is shown again`).
- [x] A chat without its transcript in memory keeps its status, asks and
      subagents, kept current by `chat.state` events, so the Agents and Plan
      panels show them without loading the transcript; its streamed items are
      not kept (`keeps a dropped chat's status and asks current, without its
      items`). A chat loaded only for them (not shown) keeps nothing more
      (`keeps only the status and asks of a chat loaded but not shown`).
- [x] A chat renders its last 200 blocks. "Show earlier" shows 200 more each
      time it is clicked, keeping the view where it was
      (`shows the last 200 blocks and counts the earlier ones`). A plan that
      waits for approval shows its card under the blocks when its row is
      among the earlier ones.
- [x] "Show in chat" from a design comment, the one jump to a chat item,
      shows earlier blocks, 200 at a time, until the comment's message is
      among them, then scrolls to its card
      (`shows earlier blocks, 200 at a time, until the item a jump goes to is
      among them`, `knows the message that carries a pin's card, by its
      design's folder (X81)`). It waits up to 5 s for a card its chat has but
      does not render yet before saying the message is not in the chat
      (`waits for a card its chat has but does not render yet, among the
      earlier blocks (X81)`).
- [x] Each Interrupted divider is found in one pass over the transcript, not
      by searching it once per divider. The dividers are the same as before
      (`marks each Interrupted that stopped a command, across the whole
      transcript`).
- [x] A streamed item replaces its earlier version by id as before, found
      from the end of the transcript, where it streams. Events held during a
      load are merged with one copy of the transcript
      (`applies events held during a load in order, the latest version of an
      item winning`).
- [x] A job's view keeps at most the last 1 MiB of its output (counted in
      characters, a newline included), dropping whole lines from the start,
      and says "Earlier output trimmed" above what it keeps. Lines keep the
      numbers they had (`keeps the end of a long output, numbered as it was,
      and says earlier output was trimmed`, `keeps at most 1 MiB of a job's
      output, however much it printed`). Stored output is read page by page
      into what is kept, never held whole.
- [x] A job's view, the Jobs panel's job detail and the phone's render the
      last 2000 lines of what they keep (after the stream filter and Find),
      and "Show earlier" adds 2000 more each time, keeping the view where it
      was; "Earlier output trimmed" shows once every kept line is rendered
      (`renders the last 2000 lines of what it keeps, and 2000 more for each
      Show earlier`).
- [x] A job's output is read chunk by chunk as it arrives: only the new
      chunks are parsed, and a line or colour code cut between chunks reads
      as before (`reads output chunk by chunk as it comes, joining a line and
      a colour code cut between chunks`).

## UI

- Chat: a "Show earlier" button above the first block shown, only when
  earlier blocks are hidden. Notes placed before the first block show only
  once every block is shown.
- Job tab and the Jobs panel's job detail: "Show earlier (N more lines)"
  above the lines rendered while some kept ones are not; then a faint
  "Earlier output trimmed" line when some output was dropped. **Copy
  output** copies what is kept.

## Protocol and RPCs

None. `chat.state` and `job.output` are read as before.

## Data and config

None persisted.

## Security considerations

None: no new inputs.

## Out of scope

- Terminals of sessions not shown keep a live xterm (X78's out of scope).

## Test plan

- Vitest, `chatMemory.test.ts`: `keeps the items of the last 8 chats shown and
  drops the others'`, `loads a dropped chat's items again when it is shown
  again`, `keeps a dropped chat's status and asks current, without its
  items`, `keeps only the status and asks of a chat loaded but not shown` and
  `reloads on connect only the chats already in memory`.
- Vitest, `chat.test.ts`: `shows the last 200 blocks and counts the earlier
  ones`, `applies events held during a load in order, the latest version
  of an item winning` and `shows earlier blocks, 200 at a time, until the
  item a jump goes to is among them`.
- Vitest, `designComments.test.ts`: `waits for a card its chat has but does
  not render yet, among the earlier blocks (X81)` and `knows the message
  that carries a pin's card, by its design's folder (X81)`.
- Vitest, `queued.test.ts`: `marks each Interrupted that stopped a command,
  across the whole transcript`.
- Vitest, `jobs.test.ts`: `keeps the end of a long output, numbered as it
  was, and says earlier output was trimmed`, `reads output chunk by chunk
  as it comes, joining a line and a colour code cut between chunks` and
  `renders the last 2000 lines of what it keeps, and 2000 more for each Show
  earlier`.
- Vitest, `jobsStore.test.ts`: `keeps at most 1 MiB of a job's output,
  however much it printed`.
- Vitest: existing `chat.test.ts`, `jobs.test.ts`, `jobsStore.test.ts`,
  `plan.test.ts` and `subagents.test.ts` stay green.
- Manual: `footprint` of the app's web content process with the user's
  sessions loaded, before and after a day of use.

## Open questions

- None.
