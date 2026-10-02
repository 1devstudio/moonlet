# R4: Local and remote hosts in one sidebar

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** R4

## Behaviour and acceptance criteria

- [x] With more than one host, the sidebar groups repos under a host header ("This Mac" first, then remotes by name) with a status dot and inline actions ("set up" for `needs_install`, "retry" for `error`).
- [x] Workspaces, agent states, unread markers, the palette, the approval inbox and notifications all work across hosts. Remote notifications name the host.
- [x] "Open in" offers VS Code and Cursor for remote workspaces through their `ssh-remote+<alias>` URLs.
- [x] The Add repository and New workspace dialogs let you pick the host.
