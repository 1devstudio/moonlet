# X18 — Colours in the agent's command output

- **Status:** implemented (2026-10-05)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journeys J2 and J3
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X14](X14-collapsed-tool-calls.md) (collapsed tool calls), [X17](X17-highlighted-tool-files.md) (syntax colours in file reads and edits)

## Summary

The agent runs its commands without a terminal, and the daemon strips colour codes from what they print, so an opened Bash or Grep call shows its output as flat grey text. X18 colours that output by recognising common shapes, the way a log viewer does: a diff looks like an Edit, JSON is highlighted, a diffstat's `+` and `-` are green and red, `path:line:` locations are dimmed, and status words such as `error` and `passed` stand out. Output that matches none of these stays plain.

Forcing colour on (`FORCE_COLOR`, `CLICOLOR_FORCE`) is not an option: the agent would read the escape codes in every result.

## User journey

1. The agent runs `git diff src/lib/chat.ts`. The user opens the row: the output is the diff view of an Edit, with green and red lines and coloured code.
2. The agent runs `git show --stat`. In the `path | 18 ++++--` lines the plus signs are green and the minus signs red; `4 files changed, …` is dim.
3. The agent runs `grep -rn "failed" tools/`. Each `tools/deploy/src/sdk.ts:352:` prefix is dim, so the matched code stands out, and `failed` is red.
4. The agent runs `gh pr merge … --json`. The JSON is highlighted.
5. The agent runs `pnpm test`. `FAIL` and `failed` are red, `passed` and `ok` green; `0 failed` stays plain.

## Behaviour and acceptance criteria

- [x] Output that is a unified diff (it starts with `diff --git` or a `---` and `+++` header pair) shows in the Edit diff view; each file in a multi-file diff is coloured by its own language, and `diff --git` and `index` lines show as dim header lines. (`toolOutput.test.ts`, `codeHighlight.test.ts`)
- [x] Output that is a JSON object or array shows highlighted as JSON. (`toolOutput.test.ts`)
- [x] In a diffstat line (`path | 18 +++--`) the `+` run is green, the `-` run red and the `|` dim; the `N files changed` summary is dim. (`toolOutput.test.ts`)
- [x] A leading location, `path:line:` or `path:line:col:` (grep -rn, rg, compilers) or `line:` (grep -n), is dim. (`toolOutput.test.ts`)
- [x] `error`, `ERROR`, `fatal`, `FAIL`, `FAILED`, `failed`, `panicked` and `×` are red; `warning`, `WARN` and `WARNING` amber; `ok`, `passed`, `PASS` and `✓` green. Only the word is coloured, whole words only, so `errorToast` and `TypeError` are not. (`toolOutput.test.ts`)
- [x] A zero count, `0 failed`, `0 errors`, `0 warnings`, is not coloured. (`toolOutput.test.ts`)
- [x] Output with none of these shapes shows plain, as before. (`toolOutput.test.ts`)
- [x] The rules apply to shell calls (Claude's Bash, Codex's shell commands) and to Grep; other tools' output is unchanged.

## UI

    ▾ Bash git show --stat
       apps/desktop/src/lib/chat.ts | 9 +++++++--      (+ green, - red, | dim)
       4 files changed, 45 insertions(+), 5 deletions(-)   (dim)
       tools/deploy/src/sdk.ts:352:  throw new Error(…)   (location dim)

Colours are the app's: green and red from the diff stat (`text-add`, `text-del`), amber from the blocked status, dim from the faint text colour. JSON and diffs use the X17 code palette.

## Protocol and RPCs

None. The output already reaches the app in `ToolCall.output`.

## Data and config

None.

## Security considerations

Command output is untrusted. The line rules return text segments that React renders as text; JSON goes through highlight.js, which escapes it, and diffs through the X17 diff view.

## Out of scope

- Keeping the commands' own ANSI colours.
- Colouring by the command that ran (`cat a.rs` as Rust).
- Tables, URLs, timestamps and log levels beyond the status words.

## Test plan

- Unit (`apps/desktop/src/lib/toolOutput.test.ts`): each shape against real output captured from saved chats (git diff, gh --json, git show --stat, grep -rn, grep -n, cargo and vitest summaries), plus the plain fallback.
- Unit (`apps/desktop/src/lib/codeHighlight.test.ts`): a two-file git diff coloured per file.

## Open questions

- None.
