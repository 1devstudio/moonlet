# T8: Warp-style block styling and input editor

- **Status:** draft
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

- [ ] **Header row:** in Warp mode the blank prompt is one empty line (zsh `PROMPT=$'\n'`, bash `PS1='\n'`, fish a `fish_prompt` that prints a newline). The header is drawn on that row. Classic mode is unchanged.
- [ ] **Header text** comes from a pure `blockHeader()` in `lib/`:
  - `<cwd> git:(<branch>) (<duration>)`, for example `~/src/app git:(main) (0.053s)`.
  - `cwd` is the directory at the `C` mark (OSC 7), `~`-shortened.
  - `git:(<branch>)` appears only when that directory is inside the session's worktree; the branch is the session's.
  - Duration uses the T7 formats (`300ms`, `1.2s`, `2m 5s`), written as seconds with three decimals under 10 s to match Warp (`0.032s`), otherwise as today.
  - A failed block adds a red `exit <code>` before the duration: `~ · exit 1 (0.300s)`.
  - A running block shows the cwd and branch with a spinner in place of the duration.
  - A block replayed from before the app attached has no duration and no parentheses.
- [ ] **Bold command:** the command line is drawn bold by the shell in Warp mode (zsh `zle_highlight=(default:bold)`, bash a bold PS1 tail reset by `PS0`, fish `fish_color_command`/`fish_color_param` with `--bold`). Output is not bold.
- [ ] **Separator:** a hairline on the top edge of the header row, spanning the whole pane width including its padding.
- [ ] **Failed block:** the block's rows get a faint red background; the red gutter mark stays.
- [ ] The T7 right-hand chip (`✓ 1.2s`) is removed; its information is in the header.
- [ ] **Spacing:** one header row per block. Two rows are tried in a throwaway prototype first; the spec is updated if two look better.

### Block selection

- [ ] **Select:** clicking a block's rows (without dragging a text selection) selects it. ⌘↑ / ⌘↓ select the previous / next block and scroll it into view; from the input editor, ⌘↑ selects the most recent block when the input is a single line. Esc clears the selection; running a new command clears it. This replaces T4's "jump to prompt" for ⌘↑ / ⌘↓.
- [ ] **Highlight:** the selected block's rows get an orange tint (`accent` at low alpha) and a 2px `accent` bar on the left edge, like the selected sidebar row (X4).
- [ ] **Copy:** with a block selected and no text selection, ⌘C copies the command and output, ⇧⌘C copies the output, ⌥⌘C copies the command. A text selection always wins over the block. With no block selected, ⇧⌘C keeps copying the last finished output (T4).
- [ ] **Re-run:** the palette's "Re-run last command" re-runs the selected block's command when one is selected.
- [ ] **Send to agent:** ⌘↵ with a block selected pastes the block as text (`$ <command>` then the output, in a fenced block) into the input of the session's running agent and focuses that agent's tab; nothing is submitted. In a structured chat (X6) it goes into the composer draft. ⇧⌘↵, or ⌘↵ when the session has no running agent, opens a new agent tab with the block as its draft. A hint under the editor reads `⌘↵ send <command> to <agent>` while a block is selected.

### Context chips

- [ ] Chips above the input are boxed (rounded, `border` hairline, mono 11.5px, an icon each), in this order:
  - **Node version** (`v24.19.0`) when the shell reports one (see Protocol).
  - **Directory**, `~`-shortened.
  - **Branch** in the `done` green, when the session has a branch.
  - **`± N`**: the number of files with uncommitted changes (staged, unstaged or untracked) in the session's worktree, from the git status jaunt already polls.
- [ ] Which chips show is decided by a pure `chipModel()` in `lib/`.
- [ ] "Classic" moves to a small icon button at the right end of the chip row, with the same tooltip.
- [ ] The `→ accept` / `⇧↵ new line` text leaves the chip row. Ghost text is followed by an inline `→` key badge.

### Input colouring

- [ ] A pure `tokenize()` in `lib/shellTokens.ts` labels each token: `env` (`VAR=x` before the command), `command`, `subcommand` (the first bare word after the command: letters, digits, `-`, `_`, `:`), `flag` (`-x`, `--x`), `string` (quoted), `path` (contains `/` or starts with `~` or `.`), `operator` (`|`, `||`, `&&`, `;`, `>`, `>>`, `<`, `&`), `argument`. After an operator the next word is a command again. Unclosed quotes run to the end.
- [ ] Colours: `command` green when the command is known, otherwise plain text (aliases and functions are invisible to the daemon, so unknown is never shown as an error); `subcommand` blue; `flag` muted; `string` yellow; `operator` faint; others plain.
- [ ] **Known commands:** executables on the shell's `PATH` plus the shell's builtins and keywords, from `shell.commands` (cached per host, refreshed when the editor mounts and at most once a minute).
- [ ] The coloured text is drawn in the existing mirror layer; the textarea text is transparent and its caret stays visible. Selection still shows.

### Completion popup

- [ ] Tab with more than one match opens a popup above the input instead of today's hint line. Each row: a folder or file icon (or a terminal icon for commands), the name with the typed prefix in bold, and a muted type label (`Directory`, `File`, `Command`).
- [ ] A side panel shows the highlighted row's full path, `~`-shortened, and its type.
- [ ] ↑ / ↓ move the highlight, Tab or Enter accept it, Esc closes. Typing narrows the list live; no match closes the popup.
- [ ] Order: directories, then files, each alphabetical; commands alphabetical. At most 200 rows, scrollable.
- [ ] The first word completes against known commands; later words complete as paths (T6 rules: dotfiles only when the stem starts with `.`).
- [ ] A single match completes in place without a popup, as today.
- [ ] Filtering, ordering, the bold range and highlight movement come from a pure `completionModel()` in `lib/`.

## UI

- Header: mono 11px, `faint`; `exit N` in `error`.
- Selected block: `accent` at about 12% alpha, 2px `accent` left bar.
- Failed block: `error` at about 6% alpha.
- Chips: `raised` background, `border` hairline, 4px radius, 2px × 6px padding.
- Popup: `panel` background, `border-strong` hairline, shadow; highlighted row `accent`-tinted.

## Protocol and RPCs

- `shell.commands {shell?}` returns `string[]`: executable file names on the login shell's `PATH`, plus the shell's builtins and reserved words, de-duplicated and sorted.
- **Node version:** the shell integration reports it with `OSC 1337;JauntNode=<version>` in the prompt hook, only when `command -v node` resolves to a different path than last time (so `node --version` runs only after the `PATH` changes, for example on `nvm use` or a directory change with an auto-switcher). An empty value means no node. The daemon stores it on `TerminalInfo.node_version` and emits `terminal.updated`.

## Data and config

None.

## Security considerations

- `shell.commands` lists file names only and runs nothing.
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

- Does zsh keep `zle_highlight` bold on the line after the command is accepted? If not, fall back to a bold PS1 tail reset in `preexec`.
