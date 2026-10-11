---
name: moonlet
description: "Read the output of the user's terminal tabs in this moonlet session (a failed command, a test run, a server log), and hand off work in another project to a new moonlet session. Use when the user mentions a terminal, a command that failed, or output you cannot see; when the task needs changes in a repository other than the current one; or to follow a session you opened. Requires MOONLET_SOCK."
---

<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->

# moonlet

moonlet runs each task as a **session**: its own git worktree and branch in a project, with an agent in it. The user sees every session in the moonlet sidebar and can take any of them over.

Check that you run inside moonlet before anything else:

```bash
test -n "${MOONLET_SOCK:-}" && test -x "${MOONLET_BIN:-}"
```

If the check fails, tell the user moonlet is not available here and stop.

## Read the user's terminals

The user runs commands in terminal tabs of this session that you cannot see. When they mention a terminal, a command that failed, a test run or a server log, read it instead of asking them to paste it:

1. List the tabs of your session:

   ```bash
   "$MOONLET_BIN" term ls
   ```

   It prints each tab's id, kind (`shell`, `run`, `setup`), status, the last command's exit code (`LAST`) and title. Pick the tab that fits, such as the one whose last command failed, or the `run` tab for a server log. If several fit, ask the user which one.

2. Read it:

   ```bash
   "$MOONLET_BIN" term read <id>
   ```

   This prints the last command the shell ran (`$ <command>`) and its output; `--lines N` prints the tab's last N lines instead, and `--json` adds the exit code. moonlet first shows the user exactly this text and asks them to allow it, so the command waits for their answer for up to 5 minutes. Run it with a tool timeout of at least 6 minutes (Claude Code: `timeout: 360000`), and tell the user you asked to read the terminal.

If the user declines (`the user declined to share terminal <id>`), do not ask again on your own and do not read the tab another way; work with what they tell you. Never type into their terminal to reproduce the output.

## Hand off work in another project

Keep your edits inside your own worktree. When the task needs a change in another project, open a session there and let its agent make the change:

1. List the projects moonlet knows:

   ```bash
   "$MOONLET_BIN" project ls
   ```

   If the project is missing, ask the user to add it in moonlet.

2. Open the session with a **self-contained prompt**. The other agent starts with none of your context, so the prompt carries the goal, the reason, and where the related work lives (your branch, PR, the files or API it must match):

   ```bash
   "$MOONLET_BIN" session new <project> "<prompt>"
   ```

   It prints the new session as JSON; keep its `id`. The session starts an agent with the prompt: the project's default agent, otherwise one like you, with your model and effort. It starts in your permission mode; `--mode` may only pick a stricter one. Other options: `--name`, `--branch`, `--from`, `--agent`, `--model`, `--effort`.

   Never start an agent in the session yourself, with `moonlet agent start` or otherwise: moonlet does not count it as the session's agent, so you cannot follow it. If the JSON shows no `agent`, tell the user.

3. Tell the user which session you opened and why.

## Follow a session

```bash
"$MOONLET_BIN" session wait <id> --timeout 600   # prints done, idle, blocked or error
"$MOONLET_BIN" session read <id>                 # its last reply, and approvals it waits for
"$MOONLET_BIN" session send <id> "<message>"     # a follow-up message
"$MOONLET_BIN" session ls                        # every live session, with its parent
```

`blocked` means the agent waits for the user to approve something: tell the user, and leave the decision to them. A timeout does not mean the message was lost; read the session before sending anything again.
