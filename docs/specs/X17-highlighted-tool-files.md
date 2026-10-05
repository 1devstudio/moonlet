# X17 — Syntax colours in the agent's file reads and edits

- **Status:** implemented (2026-10-05)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journeys J2 and J3
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X14](X14-collapsed-tool-calls.md) (collapsed tool calls)

## Summary

When the user expands a Read, Edit or Write call in the agent view, the file's contents show as plain grey text. Edits keep their green and red line backgrounds but the code inside is flat, and a Read prints its line numbers in the same colour as the code. X17 colours the code by the file's language, the way code fences in agent messages already are, and moves a Read's line numbers into a dim gutter.

## User journey

1. The agent reads `src/main.rs`. The user expands the `Read src/main.rs` row.
2. The line numbers sit in a faint column on the left; `fn`, strings and comments are coloured as in a code fence in a message.
3. The agent edits the file. The user expands the `Edit src/main.rs` row: removed lines keep their red background and added lines their green one, and the code on both is coloured too.
4. The agent reads `notes.xyz`, a type the app does not know. The text shows uncoloured, with the line-number gutter.

## Behaviour and acceptance criteria

- [x] The language comes from the file's extension (`a.rs` is Rust, `a.tsx` TypeScript, `config.toml` INI/TOML), or its name for `Makefile`; an unknown type is shown uncoloured. (`codeHighlight.test.ts`)
- [x] A Read whose output is numbered lines (`1\tcode`, or `1→code` from older Claude versions) shows each line's number in a gutter and its code coloured. (`codeHighlight.test.ts`)
- [x] A Read output that is not numbered lines (an error, an image) shows as plain text, as before. (`codeHighlight.test.ts`)
- [x] Constructs that span lines, such as a block comment, are coloured on every line they cover. (`codeHighlight.test.ts`)
- [x] An Edit, MultiEdit or Write diff keeps its added, removed and hunk lines, and colours the code by the language of the `+++` file (the `---` file for a deletion). (`codeHighlight.test.ts`)
- [x] Removed lines are coloured as the old file and added lines as the new one, so an edit that opens a comment on one side does not colour the other. A renamed file's removed lines use the old name's language. (`codeHighlight.test.ts`)
- [x] Inside a hunk, a removed `-- ` line followed by an added `++ ` line stays a removed and an added line, not a file header. (`codeHighlight.test.ts`)
- [x] A Read's language comes from the `file_path` in its input; the summary, cut to 200 characters by the daemon, is only a fallback. (`toolOutput.test.ts`)
- [x] File text is escaped: `<script>` in a file shows as text. (`codeHighlight.test.ts`)
- [x] The permission prompt's diff gets the same colours, since it is the same diff view.

## UI

    ▾ Read src/main.rs
       1  fn main() {
       2      println!("hi");
       3  }

The gutter uses the faint text colour, right-aligned, with the code beside it. Colours are the chat code-fence palette (`.hljs-*` in `jaunt.css`). Diff lines keep their existing backgrounds; the code's own colours sit on top.

## Protocol and RPCs

None. The diff and Read output already reach the app in `ToolCall.diff` and `ToolCall.output`; the file path is in `ToolCall.summary` and the diff's `+++` line.

## Data and config

None.

## Security considerations

File contents are untrusted. highlight.js escapes the text it colours and the uncoloured fallback escapes it too, so only highlight.js's own `<span class="hljs-…">` tags reach the page.

## Out of scope

- Colouring Bash output or Grep matches.
- Colouring by content when the extension is missing or unknown.
- Word-level change highlighting inside an edited line.

## Test plan

- Unit (`apps/desktop/src/lib/codeHighlight.test.ts`): language by extension and name; Read rows with gutter numbers, both number formats, the plain-text fallback and a comment spanning lines; diff rows for an Edit and a Write; escaping.

## Open questions

- None.
