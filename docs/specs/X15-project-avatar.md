# X15: GitHub owner avatar as the project icon

- **Status:** implemented
- **Priority / phase:** P1 · phase 3 (extends [X5](X5-workspaces-projects-sessions.md))
- **PRD refs:** none (user request, 2026-10-05)

## Summary

Every project row in the sidebar shows the same dotted glyph, so projects from different organizations look alike. When a project's `origin` remote is on github.com, the row shows the avatar of the account that owns the repository instead: the organization's icon for an organization repo, the user's avatar for a personal one.

## User journey

1. The user adds a project whose `origin` is `git@github.com:1devstudio/jaunt.git`.
2. The project row in the sidebar shows the `1devstudio` organization avatar where the dotted glyph used to be.
3. A project without a GitHub remote, or a machine that is offline, keeps the dotted glyph.

## Behaviour and acceptance criteria

- [x] `git.origin_url {path}` returns the URL of the repository's `origin` remote, or `null` when there is none.
- [x] The avatar URL is `https://github.com/<owner>.png?size=64` for https, `ssh://` and scp-like (`git@github.com:owner/repo.git`) remotes on github.com. Credentials in the URL are ignored.
- [x] Remotes on other hosts (GitLab, GitHub Enterprise, local paths) and projects without `origin` have no avatar.
- [x] The sidebar shows the avatar in the project row and falls back to the dotted glyph when there is no avatar or the image fails to load.
- [x] The app looks the avatars up when a host loads and when the project list changes.

## UI

`Sidebar.tsx`, `ProjectMark`: a 15 × 15 px image with 3 px rounded corners, in the place of the dotted glyph. The pure URL logic lives in `lib/projectAvatar.ts`.

## Protocol and RPCs

- `git.origin_url {path}` → `string | null`. It runs on the host that owns the project, so remote projects work the same way. An older remote helper without the method answers with an error, and the row keeps the glyph.

## Data and config

Nothing is persisted. The avatar URLs live in the app's store, keyed by project.

## Security considerations

The webview loads the image straight from GitHub, so the CSP `img-src` allows `https://github.com` (which redirects) and `https://avatars.githubusercontent.com`. Only the owner name goes into the URL, and only when it matches GitHub's account name rules (at most 39 letters, digits and hyphens, no hyphen at either end), so a crafted remote cannot inject a path or query. Credentials in the remote URL never leave the daemon's answer.

## Out of scope

- Telling organizations from users (both get their avatar).
- GitHub Enterprise hosts and remotes other than `origin`.
- A custom project icon in Project settings.

## Test plan

- `jaunt-core` `git::tests::origin_url_of_a_project`: no remote, then a remote read from a subdirectory.
- `jauntd` `tests/daemon.rs` `origin_url_over_rpc`: the RPC end to end.
- `apps/desktop/src/lib/projectAvatar.test.ts`: URL forms, credentials, non-GitHub remotes.
- Manual: a project cloned from GitHub shows its owner's avatar in the sidebar.
