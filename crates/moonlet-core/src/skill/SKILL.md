---
name: moonlet
description: "Hand off work in another project to a new moonlet session. Use when the task needs changes in a repository other than the current one, or to follow a session you opened (wait for it, read its reply, send it a message). Requires MOONLET_SOCK."
---

<!-- Installed by moonlet (`moonlet hooks install`); reinstalling overwrites this file. -->

# moonlet sessions

moonlet runs each task as a **session**: its own git worktree and branch in a project, with an agent in it. The user sees every session in the moonlet sidebar and can take any of them over.

Check that you run inside moonlet before anything else:

```bash
test -n "${MOONLET_SOCK:-}" && test -x "${MOONLET_BIN:-}"
```

If the check fails, tell the user moonlet is not available here and stop.

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
