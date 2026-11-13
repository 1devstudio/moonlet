# X101 — Session designs outside the project

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** X65 (Design mode: session designs, Build it), X95 (design library)
- **Related ADRs:** [0013](../adr/0013-design-systems-and-designs.md)

## Summary

A session design ([X65](X65-design-mode.md)) is written into the session's worktree under `docs/design/<slug>/` (or the project's `[design] dir`) and committed with the session's branch. That suits a project whose designs belong in its repository, but not one whose repository should never hold them. X101 adds a project setting, **Session designs**, with two choices: **In the project** (today's behaviour, the default) and **In ~/.moonlet/design**. With the second, `/moonlet-design` and **Build it** make the session's designs in `~/.moonlet/design/.sessions/<session id>/`, outside the worktree, so nothing of them is committed. The session's Design tab works on them as before. When the session is archived, its designs become workspace designs, so none is lost.

## User journey

1. The user opens **Settings › Projects › <project>**. Under **Design**, **Session designs** reads **In the project**. They pick **In ~/.moonlet/design** and save. `.moonlet/config.toml` gains `[design] store = "moonlet"`.
2. They start a session in the project. moonlet makes `~/.moonlet/design/.sessions/<session id>/` and starts the session's agent with that folder as one it may work in.
3. In the session they type `/moonlet-design Prototype the settings page`. The agent runs `design new --here`, which makes the design in `~/.moonlet/design/.sessions/<session id>/designs/settings-page/` and opens the session's Design tab. The agent writes the pages there without asking for approvals, as it does in the worktree.
4. Comments, edits by hand, snapshots, **Update** of the design system and the PR's Design and build work as for any session design. The Changes panel lists none of the design's files, because none is in the worktree.
5. The session's PR merges and the user archives the session. Design mode now lists **Settings page** under **Workspace designs**, with its pages, labels, viewport, brief, assets and comments, linked to the workspace's live design system. Opening it starts its own agent, and **Build it** works as for any workspace design.

## Behaviour and acceptance criteria

### The setting

- [ ] A project's `.moonlet/config.toml` may set `[design] store` to `"project"` or `"moonlet"`; with none, or any other value, its session designs are made in the project, as before X101. The setting is read from the project's own checkout, where Project settings saves it, never from a session's worktree. (`design/session.rs` a_session_design_kept_in_moonlet_is_made_in_the_sessions_design_folder_and_nothing_in_its_worktree)
- [ ] Project settings has a **Design** section with **Session designs**: **In the project** (`docs/design`, or `[design] dir`, committed with the session's branch) or **In ~/.moonlet/design** (never committed; a design becomes a workspace design when its session is archived). Saving writes `[design] store` (`project` removes the key, and the table when nothing else is in it), keeping `[design] dir` and the rest of the file as they were; a save that does not name a store leaves it as it is. Settings search finds it as **Session designs**, with its choice. (`lib/projectSettings.test.ts` reads and writes the session designs store, keeps the design folder, says where each choice keeps a session's designs; `lib/settingsSearch.test.ts` finds where a project keeps its session designs; `project_config.rs` saving_writes_the_session_designs_store_and_keeps_the_design_folder; `e2e/specs/project-settings.e2e.ts` keeps the project's session designs in ~/.moonlet/design once chosen)

### Where a session's designs are made

- [ ] When a session's Claude starts in a project set to `moonlet` (a new session, a new agent tab, or one continued on this host), moonlet makes the session's design folder `~/.moonlet/design/.sessions/<session id>/` (private, `0700`) and gives it to the agent with `--add-dir`. The agent may work in that folder only, never in another session's. A project set to `project` adds no folder. (`session.rs` a_sessions_agent_gets_its_design_folder_when_its_project_keeps_designs_in_moonlet; `moonletd/tests/daemon.rs` a_session_in_a_project_keeping_designs_in_moonlet_makes_them_outside_its_worktree)
- [ ] `design.create {session}` (`design new --here`) in a project set to `moonlet` makes the design in `~/.moonlet/design/.sessions/<session id>/designs/<slug>/`: `design.toml`, `pages/`, `assets/` and the pinned `system/`, as X65's session design has them; and its comments, history, built screenshots and the agent's copy of the whole design system in `~/.moonlet/design/.sessions/<session id>/.moonlet/design/<slug>/`. Nothing is written in the worktree. A name already used there gets a ` 2`. (`design/session.rs` a_session_design_kept_in_moonlet_is_made_in_the_sessions_design_folder_and_nothing_in_its_worktree)
- [ ] A session whose agent started before its project was set to `moonlet` has no design folder, so its agent could not write there without asking. `design new --here` then makes the folder, adds it to the session's agents from their next message (X29's add directory), makes no design and fails with "The agent can write designs in <its folder> from its next message. Send a message, then make the design again." (`moonletd/tests/daemon.rs` a_session_started_before_its_project_kept_designs_in_moonlet_gets_its_folder_from_the_next_message)
- [ ] **Build it** (`session.create {design}`) in a project set to `moonlet` copies the workspace design into the new session's design folder, made before its agent starts, never into the worktree. (`moonletd/tests/daemon.rs` building_a_design_in_a_project_keeping_designs_in_moonlet_copies_it_outside_the_worktree)
- [ ] `design.list`, `design.file`, the `{session, slug}` address of every design RPC, `design.changed` and `design.system.update` reach a session's designs in its design folder as they reach its designs in its worktree. A session has both when its project's setting changed while it was open: its designs are those of its design folder, then those of its worktree, and a slug in both is the design folder's. (`design/session.rs` a_sessions_designs_are_those_of_its_design_folder_then_of_its_worktree; `moonletd/tests/daemon.rs` a_session_in_a_project_keeping_designs_in_moonlet_makes_them_outside_its_worktree)
- [ ] `design new --here` prints the design with `side`, the absolute folder of its comments, history, built screenshots and the agent's copy of the design system, for every session design. The moonlet-design skill reads the design system from `<side>/system/` and saves built screenshots to `<side>/built/`, wherever the design is. (`moonletd/tests/daemon.rs` a_session_in_a_project_keeping_designs_in_moonlet_makes_them_outside_its_worktree)

### When the session is archived

- [ ] Archiving a session turns each design in its design folder into a workspace design of the session's workspace: its pages linking the workspace's live design system again, its labels, viewport, brief, assets and comments (its snapshots are not kept). A name the workspace has gets a ` 2`. Its folder under `.sessions/` is removed only once every design is moved; one that cannot be moved (its design system is gone) stays there and is tried again when the daemon starts. A session designs folder whose session moonlet no longer has is moved the same way, into the workspace recorded when the folder was made. (`design/session.rs` archiving_turns_a_sessions_designs_kept_in_moonlet_into_workspace_designs; `moonletd/tests/daemon.rs` archiving_a_session_turns_its_designs_kept_in_moonlet_into_workspace_designs)
- [ ] The workspace a session designs folder belongs to is recorded in `~/.moonlet/design/.sessions/<session id>.toml`, beside the folder and outside it, so the session's agent cannot change it. (`design/session.rs` archiving_turns_a_sessions_designs_kept_in_moonlet_into_workspace_designs)

## UI

Settings › Projects › <project>, a **Design** section after **Scripts**:

```
Design
  Session designs   [ In the project            v ]
                    Designs made in a session go to docs/design and are committed with its branch.
```

With **In ~/.moonlet/design** the hint reads "Designs made in a session stay out of the repository, in ~/.moonlet/design. When the session is archived they become workspace designs."

## Protocol and RPCs

- `ProjectConfig.design.store`: `"project" | "moonlet"`, absent for `project`.
- `DesignInfo.side`: a session design's comments and history folder, absolute; absent for other designs.
- No new RPC.

## Data and config

- `.moonlet/config.toml`: `[design] store = "moonlet"`; `project` by default.
- `~/.moonlet/design/.sessions/<session id>/designs/<slug>/`: a session design kept in moonlet.
- `~/.moonlet/design/.sessions/<session id>/.moonlet/design/<slug>/`: its comments, history, built screenshots and system copy.
- `~/.moonlet/design/.sessions/<session id>.toml`: `workspace = "<id>"`.

## Security considerations

- The agent's `--add-dir` is its own session's folder only. The record naming the workspace is outside it.
- Every read and write goes through the folder as a handle, never through a link, as X65's session designs do in a worktree.

## Out of scope

- Moving a session's existing designs between the worktree and `~/.moonlet/design` when the setting changes.
- A folder of the user's choosing other than `~/.moonlet/design`.
- Copies of a session's designs on other hosts (X71): they are copied once they are workspace designs.
- Workspace designs, which are in `~/.moonlet/design` already.

## Test plan

Unit tests in `design/session.rs`, `session.rs` and `lib/projectSettings.test.ts`; daemon tests in `moonletd/tests/daemon.rs`.

## Open questions

- None.
