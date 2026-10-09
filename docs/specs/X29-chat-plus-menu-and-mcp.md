# X29 — Chat input `+` menu: attachments, commands, subagents and MCP servers

- **Status:** draft
- **Priority / phase:** P1 · phase 3
- **PRD refs:** goal 2 (agent-first), journeys J2 and J3
- **Related:** [X6](X6-structured-agent-view.md) (structured agent view), [X7](X7-agent-permission-mode.md) (permission mode), [X5](X5-workspaces-projects-sessions.md) (new-session composer), [R1](R1-ssh-hosts.md) (SSH hosts)

## Summary

The chat input gets the layout of the "MCP Servers Menu" design: the input on top, and under it one row with a `+` button on the left, the session's cost and tokens in the middle, and the model, effort and permission mode on the right. The `+` button opens a menu to attach files or images, add a directory the agent may work in, insert a slash command or a subagent, and see the session's MCP servers. A server that needs sign-in can be authenticated from the menu: moonlet asks the agent for the sign-in page, opens it in the browser, and shows the server as connected once the agent reconnects. Claude Code and Codex both report their MCP servers and both support the sign-in flow, so both get the menu. The new-session composer gets the same `+` menu with the two file items only, because there is no running agent yet to ask about commands, subagents or servers.

## User journey

1. In a Claude session the user sees the input box with the placeholder `Ask for a change, @ to mention a file, / for commands`. Under it: `+` on the left, `$0.42 · 120k in · 3k out` in the middle, `Opus Medium` and `Auto` on the right.
2. The `+` has a small yellow dot. The user clicks it. A menu opens above it: `Attach files or images ⌘U`, `Add directory`, a divider, `Slash commands ›`, `MCP servers ›` with a yellow badge `2`, `Subagents ›`.
3. The user hovers `MCP servers`. A list opens beside the menu, headed `MCP servers · 9/12`, one row per server with a status dot and the name; `claude.ai Linear` has a lock. A detail card beside it shows the selected server: status, transport, endpoint, scope.
4. `Linear` is selected. The card says `Authentication required` with **Authenticate →** and **Copy link**. The user clicks Authenticate. The card changes to `Finish signing in to claude.ai Linear in your browser.` with Cancel, and the browser opens the sign-in page.
5. The user approves access in the browser and comes back. Within a few seconds the row turns green and the card lists the server's tools.
6. The user picks `Attach files or images`, chooses `screenshot.png` and `src/login.ts`. The input now has an image chip `screenshot.png` and `@src/login.ts ` in its text. Sending delivers the image to the agent with the message.
7. The user picks `Add directory` and chooses `~/work/shared-lib`. A system line in the conversation says `Added directory ~/work/shared-lib. The agent can use it from the next message.`
8. On a remote host the same Authenticate opens the browser on the Mac, and the browser's return to `localhost` reaches the agent on the host through an SSH port forward that moonlet sets up for the sign-in.

## Behaviour and acceptance criteria

### Layout and `+` menu (stack part 1)

- [ ] The footer row is under the input: `+` left, cost and tokens centred, model and effort then permission mode right. While a turn runs the centre shows `Working`, the elapsed time and `esc to stop` instead of the cost; while the agent waits it shows the waiting text. Stop and the More menu stay on the right.
- [ ] The `+` menu lists `Attach files or images` (hint `⌘U`), `Add directory`, then `Slash commands`, `MCP servers` and `Subagents`, each opening a submenu on hover. (`plusMenu.test.ts`, `plus-menu.e2e.ts`)
- [ ] `Slash commands` lists the agent's commands; choosing one puts `/<name> ` at the start of the input. An agent without commands shows `No commands`. (`plusMenu.test.ts`, `claude.rs` test)
- [ ] `Subagents` lists the agent's subagents with their descriptions, from Claude's `initialize` reply; choosing one inserts `@agent-<name> ` at the caret. The item is hidden when the agent has no subagents. (`claude.rs` test, `plusMenu.test.ts`)
- [ ] `⌘U` in the input opens the attach dialog. (`plusMenu.test.ts` for the key match)
- [ ] The new-session composer's `+` opens the same menu with `Attach files or images` and `Add directory` only.

### Attachments and directories (stack part 2)

- [ ] Attaching a file that is not an image inserts `@<path>`, relative to the session's directory when it is inside it, else absolute. (`attachments.test.ts`)
- [ ] Attaching a `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` file adds an image chip above the input; the chip's `×` removes it. The app reads the image on the Mac, so it works for remote sessions too. Images over 5 MB and files that are not images are refused with a toast. (`attachments.test.ts`, `src-tauri/src/attach.rs` tests)
- [ ] Sending with images delivers them to Claude as base64 `image` content blocks after the text, and to Codex as `image` inputs with a `data:` URL. The user's message in the conversation shows `[image: <name>]` lines. (`claude.rs`, `codex.rs` tests)
- [ ] `Add directory` picks a folder and calls `chat.add_dir`. Claude restarts on the next message with `--add-dir <path>` for every added directory (resuming the conversation); Codex resumes its thread with the directories as extra writable roots. A system line confirms the addition. Adding the same directory twice is a no-op. (`runtime.rs`, `claude.rs`, `codex.rs` tests)
- [ ] A directory added in the new-session composer shows as a chip and starts the agent with it from the first message. In the composer, attached images are @mentions like other files, because there is no conversation to send them to yet. (`session.rs` test)

### MCP server list (stack part 3)

- [ ] Opening the `MCP servers` submenu asks the agent for its servers: Claude's `mcp_status` control request, Codex's `mcpServerStatus/list`. The reply fills `ChatState.mcp_servers`. (`claude.rs`, `codex.rs` tests with captured replies)
- [ ] Each server has a status `connected`, `needs-auth`, `authing`, `failed`, `pending` or `disabled`, a transport (`http`, `sse`, `stdio`, `claude.ai`), an endpoint (URL or command), a scope when the agent reports one, an error for failed servers and its tool names. (`claude.rs`, `codex.rs` tests)
- [ ] The submenu header reads `MCP servers · <connected>/<total>`. Rows show a status dot, the name, and a lock for servers that need sign-in. The `MCP servers` item shows a badge with the number of servers that need sign-in, and the `+` shows a yellow dot while that number is above zero. (`plusMenu.test.ts`)
- [ ] The detail card shows the selected server's status label (`Connected`, `Needs authentication`, `Signing in…`, `Failed to connect`, `Starting…`, `Disabled`), transport, endpoint and scope. Connected servers list up to 6 tool names and `+N more`. (`plusMenu.test.ts`)
- [ ] A failed server's card shows its error and **Retry**, which reconnects it (Claude `mcp_reconnect`; Codex re-lists the server) and refreshes the list.
- [ ] The list is asked for each time the `+` menu opens. Before the agent has answered, the submenu shows `Loading…`. A stopped agent (after a daemon restart) is started to answer; one that cannot start shows `Start the conversation to see its MCP servers.` (`runtime.rs` test)

### MCP sign-in (stack part 4)

- [ ] **Authenticate** calls `chat.mcp_auth`. Claude gets `mcp_authenticate`, Codex `mcpServer/oauth/login`. The reply's sign-in URL is stored on the server, which turns `authing`. The app opens the URL in the default browser once, when it first appears. (`claude.rs`, `codex.rs` tests; `plusMenu.test.ts` for open-once)
- [ ] **Copy link** copies the sign-in URL and reads `Copied` until another server is selected. Before Authenticate has been clicked, Copy link first asks for the URL, then copies it.
- [ ] While any server is `authing`, the app refreshes the list every 3 seconds. A Claude server whose sign-in completes in claude.ai (no local callback) is reconnected on each refresh until it connects. Codex's `mcpServer/oauthLogin/completed` refreshes at once, and its failure marks the server `failed` with the error. (`claude.rs`, `codex.rs` tests)
- [ ] **Cancel** returns the server to `needs-auth` in moonlet; a late success still shows it connected.
- [ ] When the session runs on a remote host and the sign-in URL's `redirect_uri` points at `localhost` or `127.0.0.1` with a port, the app forwards that port from the Mac to the host over the host's SSH connection before opening the browser, and removes the forward when the server leaves `authing`. (`oauthRedirect.test.ts` for the port, `remote.rs` test for the ssh arguments)
- [ ] Sign-in errors from the agent (`Server not found`, unsupported transport) show in the card as the failed state.

## UI

    ┌ Attach files or images  ⌘U ┐┌ MCP servers · 9/12 ────┐┌ ● claude.ai Linear   Needs authentication ┐
    │ Add directory              ││ ● claude.ai Slack     › ││ Transport  claude.ai                     │
    │ ────────────────────────── ││ ● claude.ai Linear  🔒 › ││ Endpoint   https://mcp.linear.app/mcp     │
    │ Slash commands           › ││ ● figma               › ││ Scope      claudeai                       │
    │ MCP servers      ⚠ 2     › │└────────────────────────┘│ ┌ Authentication required ─────────────┐ │
    │ Subagents                › │                          │ │ Authenticate →   Copy link          │ │
    └────────────────────────────┘                          └──────────────────────────────────────────┘
    ┌ Ask for a change, @ to mention a file, / for commands                                         ↵ ┐
    └──────────────────────────────────────────────────────────────────────────────────────────────────┘
     +•                         $0.42 · 120k in · 3k out                              Opus Medium   Auto

Status dots use the sidebar's state glyphs: connected `done`, needs sign-in `blocked`, signing in `working`, failed `error`, starting `idle`.

The menu closes on Escape, on a click outside, or after an item is chosen. Hovering a row selects it in the detail card.

## Protocol and RPCs

- `ChatState` gains `agents: [{ name, description }]`, `add_dirs: [string]` and `mcp_servers: [McpServer]`, where `McpServer` is `{ name, status, transport, endpoint, scope?, error?, tools: [string], auth_url? }`. Older clients ignore them.
- `chat.send` gains `images: [{ name, media_type, data }]` (base64), optional.
- New `chat.add_dir { id, path }` returns the state.
- New `chat.mcp { id, action, server? }` with `action` one of `refresh`, `auth`, `reconnect`, `cancel`. It returns at once; the agent's answer arrives as a `chat.state` event.
- `session.create` gains `add_dirs: [string]`, optional.
- Claude: control requests `initialize` (reply's `agents`), `mcp_status`, `mcp_authenticate { serverName }`, `mcp_reconnect { serverName }`. Codex: `mcpServerStatus/list { threadId, detail: "toolsAndAuthOnly" }`, `mcpServer/oauth/login { name, threadId }`, notifications `mcpServer/oauthLogin/completed` and `mcpServer/startupStatus/updated`.
- Desktop (Tauri) commands: `read_image { path }` returns `{ media_type, data }` for an allowed image up to 5 MB; `ssh_forward { host, port, open }` adds or cancels `-L port:127.0.0.1:port` on the host's SSH control connection.

## Data and config

`agents`, `add_dirs` and `mcp_servers` are saved with the conversation in `chats/<id>.json`; `add_dirs` also persists in the chat's start config so a restored chat restarts with them. Sign-in tokens stay with the agent (Claude Code's and Codex's own credential stores); moonlet never sees them.

## Security considerations

- The sign-in URL comes from the agent. The app opens it only for `http`/`https` URLs, through the system opener, and only after a user click on Authenticate.
- The forwarded port comes from the URL's `redirect_uri`. Only ports 1024–65535 on `localhost`/`127.0.0.1` are forwarded, only to the session's own host, and the forward binds to the Mac's loopback interface.
- `read_image` reads only files with an image extension, refuses anything over 5 MB, and is called only with paths the user picked in the native dialog.
- `chat.add_dir`, `session.create` and `terminal.create` accept only absolute paths of existing directories on the session's host, so an added directory can never reach the agent's command line as a flag. (`runtime.rs` test)
- A session another agent opens (X22) cannot add directories: they widen what the agent may write, so only the user picks them. (`session.rs` test) Like X22's mode cap this guard trusts the caller's `spawned_by`; the socket is private to the user (S1), and an agent could already run any command as the user.

## Out of scope

- Adding, removing or editing MCP server configuration (use `claude mcp` or Codex's config).
- Enabling or disabling servers from the menu.
- Pasting a redirect URL by hand when the browser cannot reach the callback (`mcp_oauth_callback_url`).
- Clearing a server's saved sign-in.
- Picking files on the remote host: the attach and directory dialogs browse the Mac, as the composer's attach button already does.

## Test plan

- Rust (`crates/moonlet-core/src/chat/claude.rs`, `codex.rs`, `runtime.rs`): captured `initialize`, `mcp_status`, `mcp_authenticate` and Codex replies drive the state; image blocks; `--add-dir`; Codex writable roots.
- Rust (`apps/desktop/src-tauri/src/remote.rs`): the ssh forward arguments and port bounds.
- Vitest (`apps/desktop/src/lib/plusMenu.test.ts`, `attachments.test.ts`, `oauthRedirect.test.ts`): menu model, summary and badge, status labels, tool chips, open-once, mention paths, image detection, redirect port.
- E2E (`apps/desktop/e2e/specs/plus-menu.e2e.ts`): a fake `claude` that answers `mcp_status` and `mcp_authenticate`; the menu shows the servers and the count, Authenticate turns the server to signing in and a later refresh shows it connected; a slash command is inserted.

## Open questions

- Claude's claude.ai connectors finish sign-in on claude.ai and the CLI does not notice by itself; moonlet reconnects on each refresh. Verified that `mcp_reconnect` fails with `Server status: needs-auth` before sign-in; not yet verified live that it succeeds right after.
