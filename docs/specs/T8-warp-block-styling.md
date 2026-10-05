# T8: Warp-style block styling and input editor

- **Status:** implemented (fish's bold command line is still open)
- **Priority / phase:** P1 · phase 3 (requested 2026-10-05, with Warp screenshots)
- **PRD refs:** T1, T3, T4; "fast, modern terminal feel (in the spirit of Warp)"
- **Related:** [T4](T4-command-blocks.md), [T6](T6-input-editor.md), [T7](T7-warp-shell-model.md), [X4](X4-visual-design.md) (tokens), [T9](T9-real-command-blocks.md) (real blocks, which reuse this spec's header and selection logic)
- **Related ADRs:** [0006](../adr/0006-daemon-owned-command-blocks.md)

## Summary

Make shell terminals in Warp mode look and feel like Warp, on top of today's single xterm grid: each block gets a header line with its directory, branch and duration, the command shows in bold, blocks can be selected and sent to an agent, the editor's context shows as boxed chips, the command line is coloured as you type, and Tab completion opens a popup. Everything here is drawn with xterm decorations and the input editor; [T9](T9-real-command-blocks.md) later moves blocks into the daemon.

## User journey

1. In a session shell, the user runs `ls`. Above the command a small grey line reads `~/src/app git:(main) (0.032s)`; the command is bold; the output follows; a hairline separates it from the next block.
2. `false` fails: its header ends with a red `exit 1` and the block is faintly tinted red.
3. The user clicks the `ls` block. It turns orange-tinted with an orange bar on the left. ⌘C copies its command and output. ⌘↵ pastes it into the session's agent.
4. Back in the editor, chips above the input read `[v24.19.0] [~/src/app] [main] [± 3]`. Typing `terraform init` shows `terraform` in green and `init` in blue, followed by a faint history suggestion with a `→` key badge.
5. Typing `cd ~/Wor` and pressing Tab opens a popup listing `Workspace/` with a folder icon and "Directory", and a side panel with the full path.

## Behaviour and acceptance criteria

### Block header and command

- [x] **Header row:** in Warp mode the blank prompt is two empty lines (zsh `PROMPT=$'\n\n'`, bash `PS1='\n\n…'`, fish a `fish_prompt` that prints two newlines). The first is the gap between blocks, with the separator through its middle; the header is drawn on the second. Classic mode is unchanged.
- [x] **No empty row:** when the shell left no empty row above the command (an older shell integration, for example a daemon from before this change), the header goes at the end of the command line instead of over it, with only what fits after the command's last row: the directory goes first, then the duration, and with no room for the status nothing is shown (`inlineHeader()`). With one empty row, separator and header share it. `blockLayout()` in `lib/` decides. A block whose prompt came before the app attached finds its prompt rows the same way, two, one or none (`replayedPromptLine()`), so earlier output is never read as its command.
- [x] **Header text** comes from a pure `blockHeader()` in `lib/`:
  - `<node> <cwd> git:(<branch>) <changes> (<duration>)`, as in Warp, for example `v24.19.0 ~/src/app git:(main) 5 • +113 -30 (0.053s)`. The node version and the session's uncommitted changes (files • `+`added `-`removed lines, counts in green and red) are recorded when the command starts; each part is left out when unknown, and branch and changes only appear inside the session's worktree.
  - `cwd` is the directory at the `C` mark (OSC 7), `~`-shortened.
  - `git:(<branch>)` appears only when that directory is inside the session's worktree; the branch is the session's.
  - Duration: seconds with three decimals under 10 s, as in Warp (`0.032s`); one decimal under a minute (`12.3s`); then minutes and seconds (`2m 5s`).
  - A failed block adds a red `exit <code>` before the duration: `~ · exit 1 (0.300s)`.
  - A running block shows the cwd and branch with a spinner in place of the duration.
  - A block replayed from before the app attached has no duration and no parentheses.
- [x] **Bold command:** the command line is drawn bold by the shell in Warp mode. zsh adds `default:bold` to `zle_highlight` (the user's other entries are kept and restored in classic mode). bash ends the prompt with bold and resets it in the DEBUG trap before the command runs (`PS0` does not exist in macOS's bash 3.2). Output is not bold. fish is not bold yet: it colours every token itself, and fish is not installed to test with.
- [x] **Separator:** a hairline through the middle of the gap row above the header, spanning the whole pane width including its padding.
- [x] **Failed block:** the block's rows get a faint red background, drawn in a layer of its own over the grid (an xterm decoration disappears once its first row scrolls out of view). In Warp mode the T4 gutter mark is left out; the overview ruler keeps its colours.
- [x] The T7 right-hand chip (`✓ 1.2s`) is removed; its information is in the header.
- [x] **Spacing:** a gap row and a header row per block, and rows at 1.3× line height in Warp-mode shells (agent TUIs and classic shells keep 1.15), as Warp's rows are roomier. One header row at 1.15 was tried first and looked cramped next to Warp (user feedback, 2026-10-05).

### Block selection

- [x] **Select:** clicking a block's rows (without dragging a text selection) selects it. ⌘↑ / ⌘↓ select the previous / next block and scroll it into view; from the input editor, ⌘↑ selects the most recent block when the input is a single line. Esc clears the selection; running a new command, or typing while the terminal has focus, clears it. ⌘↓ past the newest block returns to the input editor. Only finished blocks can be selected. This replaces T4's "jump to prompt" for ⌘↑ / ⌘↓.
- [x] **Highlight:** the selected block's rows get an orange tint (`accent` at low alpha) and a 2px `accent` bar on the left edge, like the selected sidebar row (X4).
- [x] **Copy:** with a block selected, the terminal focused and no text selection, ⌘C copies `$ <command>` and the output, ⇧⌘C copies the output, ⌥⌘C copies the command, each with a toast. A text selection always wins over the block. With no block selected, ⇧⌘C keeps copying the last finished output (T4).
- [x] **Re-run:** the palette's "Re-run last command" re-runs the selected block's command when one is selected.
- [x] **Send to agent:** ⌘↵ with a block selected pastes the block as text (`$ <command>` then the output, in a code fence longer than any fence in the output) into the input of the session's running agent (the focused one, else the first) and focuses that agent's tab; nothing is submitted. In a structured chat (X6) it goes into the composer, after anything already typed. ⇧⌘↵, or ⌘↵ when the session has no running agent, opens a new tab of the session's agent (Claude when the session has none) with the block as its draft; a TUI agent gets it once it has drawn its first screen. The selection clears. With no block selected and nothing typed, ⌘↵ sends the newest finished block, as Warp attaches the last block. A hint under the editor always names the block ⌘↵ would send: ``⌘↵ send `<command>` to the agent · ⇧⌘↵ new agent tab``. Outside a selected block, ⌘↵ keeps its usual meaning.

### Context chips

- [x] Chips above the input are boxed (rounded, `border` hairline, mono 11.5px, an icon each), in this order, on one row as in Warp: the directory chip gives way first and is cut from the left, so the end of the path stays; Classic sits outside the chips, so a narrow pane never hides it:
  - **Node version** (`v24.19.0`) when the shell reports one (see Protocol).
  - **Directory**, `~`-shortened.
  - **Branch** in the `done` green, when the session has a branch.
  - **Changes** (`5 • +113 -30`, file icon): the number of files with uncommitted changes (staged, unstaged or untracked) in the session's worktree and their added and removed lines, in green and red, from the git status jaunt already polls.
- [x] Which chips show is decided by a pure `chipModel()` in `lib/`.
- [x] "Classic" moves to a small icon button at the right end of the chip row, with the same tooltip.
- [x] The `→ accept` / `⇧↵ new line` text leaves the chip row. Ghost text is followed by an inline `→` key badge.

### Input colouring

- [x] A pure `tokenize()` in `lib/shellTokens.ts` labels each token: `env` (`VAR=x` before the command), `command`, `subcommand` (the first bare word after the command: letters, digits, `-`, `_`, `:`), `flag` (`-x`, `--x`), `string` (quoted), `path` (contains `/` or starts with `~` or `.`), `operator` (`|`, `||`, `&&`, `;`, `>`, `>>`, `<`, `&`), `argument`. After an operator the next word is a command again, except after a redirection (`>`, `>>`, `<`), whose target is an argument or path. A newline also starts a new command. Unclosed quotes run to the end.
- [x] Colours: `command` green when the command is known, otherwise plain text (aliases and functions are invisible to the daemon, so unknown is never shown as an error); `subcommand` blue; `flag` muted; `string` yellow; `operator` faint; others plain.
- [x] **Known commands:** executables on the shell's `PATH` plus the shell's builtins and keywords, from `shell.commands` (cached per host, refreshed when the editor mounts and at most once a minute).
- [x] The coloured text is drawn in the existing mirror layer; the textarea text is transparent and its caret stays visible. Selection still shows.

### Completion popup

- [x] Tab with more than one match extends the word to the matches' common prefix (as T6 did) and opens a popup above the input instead of today's hint line. Each row: a folder or file icon (or a terminal icon for commands), the name with the typed prefix in bold, and a muted type label (`Directory`, `File`, `Command`).
- [x] A side panel shows the highlighted row's full path, `~`-shortened, and its type.
- [x] ↑ / ↓ move the highlight, Tab or Enter accept it, Esc closes. Typing narrows the list live; no match closes the popup.
- [x] Order: directories, then files, each alphabetical; commands alphabetical. At most 200 rows, scrollable.
- [x] The first word completes against known commands; later words complete as paths (T6 rules: dotfiles only when the stem starts with `.`).
- [x] A single match completes in place without a popup, as today.
- [x] Filtering, ordering, the bold range and highlight movement come from a pure `completionModel()` in `lib/`.

## UI

- Header: mono at 85% of the terminal font size, `muted`; `exit N` in `error`.
- Selected block: `accent` at about 12% alpha, 2px `accent` left bar.
- Failed block: `error` at about 6% alpha.
- Chips: `raised` background, `border` hairline, 4px radius, 2px × 6px padding.
- Popup: `panel` background, `border-strong` hairline, shadow; highlighted row `accent`-tinted.

## Protocol and RPCs

- `shell.commands {shell?, terminal?}` returns `string[]`: executable file names in the absolute directories of a PATH, plus the shell's builtins and reserved words, de-duplicated and sorted. The PATH is the terminal's own, as its prompt hook last reported it with `OSC 1337;JauntPath=<PATH>` (sent only when it changes, so it includes what rc files and later `PATH=` added); without one, the login shell's. The app caches the answer per terminal for a minute.
- **Node version:** the prompt hook reports where `node` is with `OSC 1337;JauntNodePath=<path>`, only when the `node` found on PATH (zsh `$commands[node]`, bash `type -P`, fish `command -s`) is a different absolute path than last time; an empty value means none. It never runs `node`. The daemon reads the version from the `include/node/node_version.h` installed beside its `bin/`, or else from a version directory in the resolved path (such as Homebrew's `Cellar/node/22.1.0`), stores it on `TerminalInfo.node_version` and emits `terminal.updated`.

## Data and config

None.

## Security considerations

- `shell.commands` lists file names only and runs nothing.
- The node version is read from files, never by running `node`: any PATH entry, relative or absolute (`$PWD/node_modules/.bin`), can point into an untrusted checkout, and the prompt hook would otherwise run that checkout's `node` without a command from the user.
- Text sent to an agent is pasted as a bracketed paste and never submitted; the user presses Enter.

## Out of scope

- Real per-command grids, collapsing, sticky headers ([T9](T9-real-command-blocks.md)).
- Command descriptions on hover, Warp AI suggestions.
- Flag and argument completion from command specs.

## Test plan

- TS (Vitest, `lib/`):
  - `blockHeader`: `~/src/app git:(main) (0.053s)`, `~ · exit 1 (0.300s)`, running, replayed, cwd outside the worktree has no branch.
  - Block selection: `blockAt(blocks, line)`, `selectStep` at both ends of the list.
  - `chipModel`: node chip only with a version, branch only with a session branch, `± N` counts staged, unstaged and untracked files once each.
  - `tokenize`: `terraform init -upgrade`, `FOO=1 git commit -m "a b" && ls | wc -l`, `cd ~/src`, an unclosed quote.
  - `completionModel`: ordering, bold range, highlight wrap, live narrowing.
  - The agent paste text for a block.
- Rust:
  - zsh and bash in Warp mode print exactly one newline as the prompt and no `USERPROMPT` (extends `blanks_and_restores`).
  - `shell.commands` lists an executable placed in a temporary `PATH` directory and skips a non-executable file.
  - The node version mark is emitted once, and again after `PATH` changes.
- e2e (`e2e/specs/`): run `echo hi`, click its block, press ⌘C and read `$ echo hi` and `hi` from the clipboard; run `false` and see `exit 1` in its header.
- In the app: compare against the Warp screenshots of 2026-10-05; check that zsh keeps the command bold after it runs (first thing to check).

## Open questions

- fish: making the command line bold.

## Verification

- 2026-10-05: zsh keeps `zle_highlight` bold on the line after the command is accepted (checked in a PTY: each character is drawn with `\e[1m` and the reset comes after Enter).
- 2026-10-05, block layout: the user's app ran this branch's UI against the installed 0.1.7 daemon, whose shell integration has no header row, and the header covered the command. Now a gap row and a header row per block, the header scaled to the terminal font, and a fallback to the end of the command line; checked in the e2e app.
- 2026-10-05, completion popup: in the e2e app, `cd ci` + Tab with `acmeco-paas/` and `acmeco-sdd/` present completed to `cd acmeco-`, showed both directories with the side panel, ↓ and Enter gave `cd acmeco-sdd/`; `gi` + Tab listed commands from PATH.
- 2026-10-05, input colouring: in the e2e app, `FOO=1 git commit -m "fix it" && ls -la ~/src | wc -l > out.txt; nosuchcmd x` showed the known commands green, `commit` blue, flags muted, the string yellow, operators faint and `nosuchcmd` plain; a selection lined up with the coloured text.
- 2026-10-05, block selection: in the e2e app, a click on a block's output row highlighted the block in orange with the left bar.
- 2026-10-05, block header: in the e2e app, `ls -la`, `false`, `printf` and `sleep 3` showed headers with the directory and duration, `· exit 1` in red with a red-tinted block, a spinner while `sleep 3` ran, and bold commands.
