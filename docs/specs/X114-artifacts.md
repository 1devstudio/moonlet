# X114 — Artifacts: plans and designs, referred to from any session

- **Status:** draft
- **Priority / phase:** P1 · phase 4
- **PRD refs:** Design mode, Plan approval
- **Related ADRs:** none
- **Depends on:** [X20](X20-plan-approval.md) and [X24](X24-plan-panel.md) (plans), [X38](X38-new-agent-tab-context.md) (Add plans), [X54](X54-new-session-composer.md) (attachments), [X65](X65-design-mode.md) (designs, Build it), [X95](X95-design-library.md) (shared designs), [X101](X101-session-designs-outside-the-project.md), [X104](X104-move-a-session-design-to-the-workspace.md)
- **Design:** session design `artifacts` (pages `index`, `search`, `design`, `used-by`, `attach`, `at-picker`, `at-files`, `start-session`, `copy-move`, `transcript`)

## Summary

A session's agent writes plans, and a session or Design mode makes designs, but neither can be used from another session: a design belongs to the session that made it, and a plan lives in Claude's own `~/.claude/plans/` and is gone from view once its chat is. X114 makes both **artifacts**. An artifact has one **home**, where it changes (a session, or the workspace), a stable id, and versions. Every artifact of a workspace is listed under a new **Artifacts** row in the sidebar, searchable by name and by plan text. Any session can **refer** to one: a live, read-only reference, so its agent always reads the latest version, and is told when it changed. A new session can start from one. Artifacts can be copied to another workspace, and a workspace artifact moved.

## User journey

1. In the session "Add search to the product list", Claude proposes a plan and the user approves it. Without doing anything, the plan is an artifact named after the session.
2. In another session, "Search results page", the user types `@add sea` in the chat input. The picker lists the plan under **Plans**, the "Settings page" design under **Designs**, and matching files under **Files**. They pick the plan: a chip "Add search to the product list · live" sits in the input, and their message goes with it.
3. Claude reads the plan from a read-only folder moonlet keeps up to date. Later the first session's plan changes; the user's next message in "Search results page" starts with "Add search to the product list changed since Claude last read it".
4. The user opens **Artifacts** in the sidebar, searches "debounce", and finds the plan by its text. **Start session** opens the New session composer with the plan attached; Create starts a session that implements it.
5. The "Checkout flow" design was made in a session and two others now use it. Its view says "Used by 2 other sessions" with **Move to workspace**.
6. The user copies the "Settings page" design to their "Personal" workspace from its `⋯` menu.

## Behaviour and acceptance criteria

### Artifacts and their homes

- [ ] An artifact is a **plan** or a **design**. Its **home** is where it was made: a design made in a session, or a plan written by a session's agent, has that session as its home; a design made in Design mode has its workspace. It changes only in its home.
- [ ] An artifact has an id that never changes while it lives: a plan's is `plan:<session id>:<key>`, the key being its plan file's name, else its chat's Claude conversation; a design's names where it is and its slug, `design:workspace:<workspace>:<slug>`, `design:library:<slug>`, `design:session:<session>:<slug>` or `design:project:<project>:<slug>`. When a design moves (to the workspace, X104; on archive, X101; to another workspace), moonlet records its old id as an alias of its new one, so a reference keeps finding it. A copy gets a new id. (`lib/artifacts.test.ts` gives each design an id from where it lives)

### Plan artifacts (entry 1)

- [ ] Every `ExitPlanMode` plan a session's chat proposes is saved as a version of that chat's plan artifact, in `~/.moonlet/artifacts/plans/<session id>/<key>/`, whether the user approves it, rejects it, or answers nothing. A plan proposed again with the same text adds no version. A plan of a chat outside any session is not kept. (`artifact/plans.rs` a_proposed_plan_is_kept_as_its_first_version_waiting_for_an_answer, a_plan_proposed_again_with_the_same_text_adds_no_version, a_plan_with_an_unsafe_key_or_no_text_is_not_kept; `chat/runtime.rs` a_sessions_proposed_plan_is_kept_as_a_plan_artifact_with_its_answer, a_plan_outside_any_session_is_not_an_artifact; `moonletd/tests/daemon.rs` a_plan_a_sessions_agent_proposes_is_an_artifact_the_app_renames_and_edits)
- [ ] A version is `pending` until the user answers it, then `approved` or `rejected` from that answer, also after a daemon restart (kept asks). A call Claude closes at the end of a turn, interrupted or not, is no answer, and the same text proposed again waits for its own. (`artifact/plans.rs` approving_or_rejecting_a_plan_answers_its_version, the_same_text_proposed_again_after_an_answer_waits_for_its_own; `chat/runtime.rs` a_sessions_proposed_plan_is_kept_as_a_plan_artifact_with_its_answer, a_plan_rejected_after_a_daemon_restart_is_kept_as_rejected)
- [ ] A plan's **name** is its session's name; when the session has plans from several chats, `<session name> · <chat title>`; when the session has no name yet (moonlet names it "Untitled"), the plan's first `#` heading, else its first line. It follows the session's renames until the user renames the plan, which keeps their name. (`artifact/plans.rs` a_plan_is_named_after_its_session_its_chat_or_its_heading, a_renamed_plan_keeps_its_name_until_it_is_given_back; `moonletd/tests/daemon.rs` a_plan_a_sessions_agent_proposes_is_an_artifact_the_app_renames_and_edits)
- [ ] A plan's text may be **edited by hand** from its view: the edit is saved as a new version, `edited`, and the home chat's next message starts with "The plan was edited by hand: <path of the latest version>", one line for the latest of several edits. An edit that changes nothing adds no version. (`artifact/plans.rs` an_edit_by_hand_is_a_new_version_and_one_changing_nothing_is_none; `chat/runtime.rs` two_edits_by_hand_before_a_message_tell_the_latest_once; `moonletd/tests/daemon.rs` a_plan_a_sessions_agent_proposes_is_an_artifact_the_app_renames_and_edits)
- [ ] A session's plans stay listed and readable after the session is archived, read only: the list says `archived` in its home, and renaming or editing one is refused. (`artifact/plans.rs` plans_are_listed_for_the_sessions_asked_about; `moonletd/tests/daemon.rs` a_plan_a_sessions_agent_proposes_is_an_artifact_the_app_renames_and_edits)
- [ ] Only the app may rename or edit a plan; an agent's CLI is refused. (`moonletd/tests/daemon.rs` a_plan_a_sessions_agent_proposes_is_an_artifact_the_app_renames_and_edits)

### The Artifacts list and view (entry 2)

- [ ] The Sessions sidebar has an **Artifacts** row between **Run action** and **History**. It swaps the sidebar's list for the workspace's artifacts, as History does: a search field, **All · Plans · Designs**, and one row per artifact, sorted by its last change, newest first. A row shows its kind's icon, its name, its home (`<project>`, `<project> · archived`, `<project> · merged`, or `Workspace`), its age, and `used by <n>` when other sessions refer to it. (`lib/artifacts.test.ts` lists plans and designs together, newest change first, each with its home and age, shows only the kind picked, says how many other sessions use an artifact, names a project as the artifact's own host names it, lists a design copied to another Mac once, from the Mac that owns it, lists a shared design under the library; `e2e/specs/artifacts.e2e.ts` lists the plan under Artifacts, named after its session)
- [ ] The search matches names, plan text (the latest version), and design names, labels and briefs, ignoring case; a row found by its text shows the matching snippet with the match marked. Page HTML is not searched. Plan text is searched by each host (`artifact.search`), designs by the app from the designs it lists. (`artifact/plans.rs` a_snippet_is_the_line_the_text_was_found_on_cut_around_it; `moonletd/tests/daemon.rs` plans_are_found_by_their_name_or_their_text; `lib/artifacts.test.ts` while searching, keeps the plans each host found and the designs found by name, brief or page label, with the line found; finds a design by its name, then its brief, then a page's label; marks every place the query is, ignoring case; marks the match itself; `e2e/specs/artifacts.e2e.ts` finds the plan by its text and marks where)
- [ ] Clicking a row opens the **artifact view** in the main area:
  - a plan: its latest version as markdown; a side panel with its **Versions** (state and age, each opening read only), **Used by** (each opening its session), and a note on live references;
  - a design: its pages as thumbnails with their labels and paths; **Pages**, **Used by**, and where it is edited.
  - Its header has **Edit**, **Attach to session…** (entry 3) and **Start session** (entry 5), and `⋯` with **Copy to workspace…**, **Move to workspace…** (workspace artifacts only, entry 6) and, for a plan, **Rename…**. (`lib/artifacts.test.ts` names the version shown, its state and age; says a version edited by hand was edited by the user; is read only in an archived session, or on an older version; `e2e/specs/artifacts.e2e.ts` opens the plan with its text and versions)
- [ ] **Edit** on a design opens its home: the design screen for a workspace design, its session's Design tab for a session design. On a plan it edits the text in place (above). (`lib/artifacts.test.ts` finds the design an artifact is, never another of the same slug)
- [ ] The list is the workspace's artifacts on every host the app is connected to, merged; one host that cannot be reached lists its own as unreachable and the rest stay. (`lib/artifacts.test.ts` names the hosts whose artifacts are not listed because they cannot be reached)

### Live references (entry 3)

- [ ] A session refers to an artifact with **Attach artifact** (the chat input's `+` menu), **Attach to session…** (the artifact view), the `@` picker (entry 4), or a session made from it (entry 5). The chat input shows a chip, `<name> · live`, with ×; the message sent with it carries one line per artifact:
  `Artifact "<name>" (<kind>, live, read only): <folder>. It always holds the latest version; it changes only in its home.` (`lib/artifacts.test.ts` puts each artifact's line before what the user typed; `lib/plusMenu.test.ts` offers Attach artifact after the files in a session's chat (X114); `lib/artifactStore.test.ts` refers the session to each artifact picked, in order, gives their lines and clears them, gives a session with no chips the same empty list each time; `e2e/specs/artifacts.e2e.ts` attaches the plan to another session, whose next message refers to it live, its line first)
- [ ] moonlet keeps a read-only copy of each referred artifact in the session's reference folder, `~/.moonlet/artifacts/refs/<session id>/<slug>/`: a plan's latest version as `plan.md`; a design's `pages/`, `assets/`, `system/` and `design.toml`. The session's Claude gets that folder with `--add-dir`, and `--settings` denies `Edit` and `Write` in it; every file of a copy is read only too. A design merged into its project is read from the project, never referred to. A chat started in the session after an attach, or continued in it, gets the folder too. (`artifact/refs.rs` a_session_refers_to_an_artifact_once_and_its_referrers_are_known, two_copies_staged_at_once_are_built_apart_and_the_last_put_in_place_shows, a_plans_copy_is_its_text_read_only_and_follows_it, a_designs_copy_has_its_pages_assets_and_system_read_only_and_nothing_else; `chat/runtime.rs` a_folder_referred_to_is_given_to_claude_read_only_from_the_next_message; `moonletd/tests/daemon.rs` a_session_refers_to_another_sessions_plan_live_and_read_only, a_session_refers_to_a_workspace_design_and_follows_its_pages, a_reference_reaches_later_chats_says_once_its_artifact_was_deleted_and_ends_with_its_session)
- [ ] When a referred artifact changes, its copy is updated as soon as moonlet hears of the change, and the referring chat's next message starts with "<name> changed since you last read it: <folder>". Several changes before that message give one line. A question kept through a daemon restart carries the line with its answer. Changes made while moonlet was not running, or missed, are copied when it starts or notices. A copy that could not be put in place is made again on the next change. (`artifact/refs.rs` a_version_is_new_to_a_session_once, a_version_whose_copy_was_not_put_in_place_is_new_again, every_artifact_referred_to_is_listed_once; `artifact/design_id.rs` a_design_id_names_where_the_design_lives_and_reads_back; `chat/runtime.rs` a_line_told_to_a_session_comes_before_its_chats_next_message, a_line_told_while_a_question_waits_goes_with_its_answer_after_a_restart; `moonletd/tests/daemon.rs` a_design_changed_while_moonlet_was_stopped_is_copied_again_at_start, `moonletd/tests/daemon.rs` a_session_refers_to_another_sessions_plan_live_and_read_only, a_session_refers_to_a_workspace_design_and_follows_its_pages)
- [ ] (Not yet: references are kept on the host the session runs on, to artifacts of that host.) When the artifact's home is on a host that cannot be reached, the copy stays as it was, and the next message says "<name>: its home, <host>, is unreachable since <time>; this is the last copy".
- [ ] A referred artifact that is deleted stays as its last copy, and the next message says so once: "The artifact in <folder> was deleted in its home; that folder keeps its last copy." (`moonletd/tests/daemon.rs` a_reference_reaches_later_chats_says_once_its_artifact_was_deleted_and_ends_with_its_session)
- [ ] Removing the chip before sending refers to nothing: a chip is referred to only when its message is sent. A sent reference stays until the session is archived; archiving ends it and removes its copies. An artifact listed from another host than the session's cannot be picked yet: sending says so and the chip stays. The same artifact is picked once; the same id listed from two hosts is two. (`lib/artifactStore.test.ts` picks an artifact once, and the same id on another Mac apart, keeps an artifact of another Mac picked, and says why; `moonletd/tests/daemon.rs` a_reference_reaches_later_chats_says_once_its_artifact_was_deleted_and_ends_with_its_session)
- [ ] X38's **Add plans** in a new chat attaches the session's plan artifacts as live references, in place of a copy written to the worktree; a plan without a plan file is still written as before. (`lib/artifacts.test.ts` is the session and the plan file's name, as the daemon keys a plan)

### The @ picker (entry 4)

- [ ] Typing `@` in a session's chat input opens a picker that matches what follows, fuzzily, in three sections, **Plans · Designs · Files**, at most 5 each, with **Show all** on a section with more, and the tabs' counts; a section Tab narrowed to shows at most 200 rows. Tab narrows to the next section, ⇧Tab goes back; ↑↓ move; ↵ picks; Esc closes and keeps the text, even when nothing matches. Plans and designs listed while it is open show at once. It extends X30's `@` file list; a chat outside a session keeps that list. (`lib/atPicker.test.ts` lists plans, designs and files that match, at most five of each, with where each lives, narrowed to one section, lists all of its matches, leaves out a section with nothing found, and lists everything for a bare @, counts each section's matches whichever section is shown, for the tabs, shows at most 200 rows of a section narrowed to, and counts them all, Tab narrows, Enter picks a row, Esc closes, even with no row, is the rows in the order shown, goes All, Plans, Designs, Files and round again; `e2e/specs/artifacts.e2e.ts` @ lists the plan under Plans and the session's files under Files; Tab narrows, Enter picks)
- [ ] Files are the session's worktree files, ranked as ⌘P ranks them (X96). Picking a file inserts `@<path>`; picking an artifact replaces the typed `@…` with its chip. (Not yet: each file's git status.) (`lib/atPicker.test.ts` takes the typed @word out, also past the caret, and keeps one space; `e2e/specs/artifacts.e2e.ts` @ lists the plan under Plans and the session's files under Files; Tab narrows, Enter picks)

### Start a session from an artifact (entry 5)

- [ ] **Start session** on any artifact but a merged design opens the New session composer in its project (its home's project; a workspace design's, the composer's own pick) with the artifact as the composer's chip, its live reference as an attachment, and the prompt placeholder "Anything to add? Leave empty to implement the plan." (or "…to build the design."). The session is named "Implement <plan>" or "Build <design>". (Not yet: a plan that names a design artifact attaching that design too.) (`lib/artifacts.test.ts` names the session for what it does with it, says in the prompt what an empty one does; `e2e/specs/artifacts.e2e.ts` starts a session from the plan, which refers to it from its first message)
- [ ] Create makes the session with no first message, refers it to the artifact, then sends its first message: the artifact's line, then what was typed, else "Implement the plan." or "Build the design.". The agent gets the reference folder from that message. Only a Claude or Codex session, on the artifact's own host, can start from an artifact: the composer says so before any session is made. When the first message cannot be sent, the session is kept and the artifact stays picked in its chat input, to send again. **Build it** on a workspace design keeps copying the design into the session (X65); Start session refers to it instead. (`lib/artifacts.test.ts` asks what was typed, else to implement the plan or build the design, starts with Claude or Codex, on the artifact's own Mac, says why it cannot otherwise, before any session is made; `e2e/specs/artifacts.e2e.ts` starts a session from the plan, which refers to it from its first message, the plan's line, then "Implement the plan.")

### Copy and move between workspaces (entry 6)

- [ ] **Copy to workspace…** copies any artifact into another workspace as a workspace artifact: a plan as a workspace plan with its latest version, a design as a workspace design with its pages, labels, viewport, brief, assets and comments, not its snapshots. The copy has a new id.
- [ ] **Move to workspace…** moves a workspace artifact, keeping its id; sessions that refer to it keep reading it. A session's artifact can only be copied.
- [ ] A session design referred to by another session shows "Used by <n> other sessions" in its view, with **Move to workspace** (X104) and **Not now**, which hides it until another session refers to it.
- [ ] When a session is archived, its designs become workspace designs whichever store keeps them (X101 extended to the project store); the committed copy stays in the branch.

### The CLI (entry 7)

- [ ] `moonlet artifact ls [--kind plan|design] [--search <text>]` lists the workspace's artifacts as JSON; `moonlet artifact show <id>` prints one (a plan's latest text); `moonlet artifact attach <id>` refers the agent's own session to it and prints its folder. An agent's CLI may run these; it may not rename, edit, copy or move.
- [ ] The moonlet skill tells the agent how to find and attach artifacts.

## UI

The design's pages are the reference.

- **Sidebar** (`index`, `search`): Artifacts row with the `layers` icon; search field, segmented All/Plans/Designs, rows with a 22 px kind tile (plan: `list-checks` in the accent colour; design: `pen-tool` in the merged colour).
- **Artifact view** (`index`, `design`): a 52 px header with the kind tile, name, kind, the three actions and `⋯`; a line under it naming the home; the body; a 260 px side panel.
- **Used by banner** (`used-by`) above a session design's pages; the row's right-click menu has Open, Edit in its session, Start session, Attach to session…, Move to workspace, Copy to workspace….
- **Chat input** (`attach`, `at-picker`, `at-files`): chips above the text; the `+` menu's **Attach artifact** row opens a search panel beside it; the `@` picker sits above the input.
- **Composer** (`start-session`): the artifact as the chip after the project, attachment rows "Plan, live and read only · <name> · v<n>".
- **Copy or move** (`copy-move`): Copy/Move segmented control, the workspaces as a radio list, the current one disabled.
- **Transcript** (`transcript`): a sent message shows its chips without ×; the changed, edited-by-hand and deleted lines show above the message they came with, and the reference lines themselves are left out of what it shows; a note line is one that names a folder (`lib/artifacts.test.ts` reads the artifacts a message refers to and the notes before it, then what the user typed, reads a plan edited by hand, and leaves a message with no artifact lines alone, reads the daemon's notes, a blank line, then the artifact lines, as the agent gets them, takes a note only when it names a folder; `e2e/specs/artifacts.e2e.ts` attaches the plan to another session, whose next message refers to it live).

## Protocol and RPCs

- `artifact.list {workspace}` → `ArtifactInfo[]`: `{id, kind: "plan"|"design", name, home: {workspace, session?, project?, archived?, merged?}, updated_at, version?, used_by: string[], design?: DesignInfo}`.
- `artifact.search {workspace, query}` → `ArtifactMatch[]`: `{id, snippet?, field: "name"|"text"|"brief"|"label"}`.
- `artifact.read {id, version?}` → `{info, text?, versions?: [{n, state, at, path}]}`.
- `artifact.rename {id, name}`, `artifact.edit {id, text}` → the new version. App only.
- `artifact.attach {session, id}` → `{folder}`; `artifact.refs {session}` → `ArtifactRef[]`.
- `artifact.copy {id, workspace}`, `artifact.move {id, workspace}` → the new or same id. App only.
- Event `artifact.changed {id}` after a plan's new version, a rename, or a design's change.
- Allowed to an agent's CLI (`LOCAL_METHODS`): `artifact.list`, `artifact.search`, `artifact.read`, `artifact.attach` (its own session only).

## Data and config

- `~/.moonlet/artifacts/plans/<session id>/<key>/plan.toml`: `{session, key, chat title, renamed?, created_at}`, and `v<n>.md` with `versions` in `plan.toml`: `{n, state, at}`.
- `~/.moonlet/artifacts/refs/<session id>.toml`: the session's references, `{id, attached_at, told_version}`; its copies in `~/.moonlet/artifacts/refs/<session id>/<slug>/`.
- `~/.moonlet/artifacts/moved.toml`: the old ids of designs that moved, each with its new id (entry 6).

## Security considerations

- The reference folder is read only to the agent: `--settings` denies `Edit` and `Write` in it by its real path (as X64's sync agent), and moonlet rewrites it from the home on every change, so an edit there never reaches the home.
- An agent may attach artifacts to its own session only: `artifact.attach` from a CLI checks the caller's `MOONLET_SESSION` against `session`.
- Plan text and design pages are data: the line sent to the agent names a folder, never pastes their text.
- Copies and moves are the user's: the app alone may call them.

## Out of scope

- Pinning any file as an artifact (later).
- References for Codex sessions get the line and the folder, but Codex makes no plans.
- Sharing a plan to every workspace (X95 sharing stays for designs).
- Comments on plans.

## Test plan

- Rust (`moonlet-core` `artifact/`): a plan's versions from proposals, approvals, rejections and a restart's kept ask; names from the session, several chats, an unnamed session, a rename; an edit by hand; search over names and text.
- Rust (`moonletd/tests/daemon.rs`): a fake Claude proposing a plan makes an artifact listed by `artifact.list`; an attached plan's copy changes when the plan does, and the next message starts with the changed line; an agent's CLI may attach to its own session only.
- Vitest (`lib/artifacts.test.ts`, `lib/atPicker.test.ts`): rows and their home and age lines, search snippets, the picker's sections and keys, the reference line.
- e2e (`artifacts.e2e.ts`): open Artifacts, find a plan by its text, attach it in another session.

## Delivery

One gh stack:

| Entry | Branch | What |
|---|---|---|
| 0 | `feature/how-to-refer-from-one-session-to-a-design-that` | this spec |
| 1 | `x114/plans` | plan artifacts in core and the daemon, `artifact.list` (plans), `artifact.read`, `artifact.rename`, `artifact.edit` |
| 2 | `x114/list` | designs in `artifact.list`, `artifact.search`, the Artifacts row, list and view |
| 3 | `x114/refs` | live references, the `+` menu, Attach to session…, X38 Add plans |
| 4 | `x114/at-picker` | the `@` picker |
| 5 | `x114/start` | Start session from an artifact |
| 6 | `x114/workspaces` | copy and move, the used-by banner, the archive rule |
| 7 | `x114/cli` | `moonlet artifact`, the skill |

## Open questions

- None open. Decided with the user on 2026-11-26: one home per artifact; live read-only references; plans saved automatically and edited by hand; workspace visibility with copy/move; references keep reading after a move; the Artifacts row in the sidebar.
