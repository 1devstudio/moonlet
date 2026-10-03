# T6: Warp-style input editor with suggestions

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (requested 2026-10-03)
- **PRD refs:** T1, T3 (shell integration), T5; "fast, modern terminal feel (in the spirit of Warp)"
- **Related:** [T3](T3-shell-integration.md)

## Summary

At a shell prompt, typing happens in a real text editor docked under the terminal, as in Warp. You can click to place the cursor, select with the mouse or keyboard, edit multi-line commands, and accept a ghost-text suggestion from your history. When a command runs, or a full-screen program takes over, the terminal gets the keys as usual.

## Behaviour and acceptance criteria

- [x] **When the editor shows:** only in shell terminals while the shell is at a prompt.
  - It tracks the OSC 133 marks: `A` (prompt) or `D` (finished) show it; `C` (command running) hides it.
  - It also hides while the alternate screen is active (vim, htop, less).
  - Without shell integration it never shows, and the terminal behaves as before.
- [x] **Editing:** mouse placement, mouse and ⇧-arrow selection, ⌘C/⌘V/⌘X/⌘A, ⌥←/⌥→ word moves and ⌘←/⌘→ line moves, all from the native text control.
- [x] **Keys:**
  - **Enter** runs the command, sent as one bracketed paste followed by Enter so multi-line text and special characters arrive intact. **⇧Enter** inserts a newline.
  - **↑/↓** walk history when the cursor is on the first or last line.
  - **Esc** hands focus to the terminal.
  - **Ctrl+C** clears the input. With empty input it sends ^C to the shell.
  - **Ctrl+L** clears the screen.
- [x] **Suggestions:**
  - The ghost text is the most recent history entry starting with the current input. Prefix matching is case-sensitive; with nothing typed there is no suggestion.
  - **→** at the end of the input or **Tab** accepts it all; **⌥→** at the end accepts one word.
  - **Tab** with no suggestion completes the last word as a path in the shell's current directory: a single match is completed, otherwise the longest common prefix.
- [x] **History:**
  - It comes from `shell.history {shell}` on the terminal's host. The daemon reads the user's zsh history (extended or plain format, `\`-continued lines), bash history (skipping `#timestamp` lines) or fish history (`- cmd:` entries).
  - Entries are de-duplicated, newest last, capped at 5,000.
  - Commands run through the editor are added for the rest of the app session.
- [x] **Context chips:** above the input, the current directory (OSC 7, `~`-shortened) and the git branch of the session.
- [x] **Typing while the terminal has focus:** if the editor is showing, printable keys typed into the terminal move focus to the editor and are inserted there. Selecting text in the terminal output still works.
- [x] Agent, run and setup terminals are unchanged.

## Protocol

`shell.history {shell?: "zsh"|"bash"|"fish"}` returns `string[]`. The shell defaults to the user's login shell.

## Test plan

- Rust: history parsers for each shell format, de-duplication and the cap.
- TS: `suggest()` prefix matching and word-wise acceptance, `commonPrefix()`.
- In the app: type a partial command, see the ghost text, accept it with →, click in the middle of the input to edit, run it, confirm the output appears and the editor returns at the next prompt; open `vim` and confirm the editor hides.

## Verification (2026-10-03)

In the app, in a fresh test shell:
- `git st` showed the ghost text `atus` from the user's zsh history (369 entries); → accepted it, Enter ran it, the output appeared and the editor returned at the next prompt.
- `vi` hid the editor (`alt_screen = true`) and keys went to vim; `:q` brought the editor back.
