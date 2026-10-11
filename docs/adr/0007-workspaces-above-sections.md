# ADR 0007: Workspaces above sections

- **Status:** accepted (2026-10-11)
- **Amends:** [ADR 0005](0005-workspace-project-session-terminal.md), where a workspace was a named set of projects.

A workspace now has to carry things that apply to everything in it, starting with which Claude account its agents use ([X33](../specs/X33-workspace-claude-profiles.md)). ADR 0005's workspaces could not: several were shown at once, and a project could sit in more than one. So ADR 0005's workspace is renamed **section** throughout code, protocol and storage (`workspace.*` RPCs become `section.*`), and **workspace** is a new scope above sections, shown one at a time behind a switcher ([X32](../specs/X32-workspaces-and-sections.md)). The old "section" (a named group of sessions inside a workspace) is removed: the design has no level for it.

A project can still be in several workspaces, so the same repo can be used with two accounts. That makes "which workspace is this session in?" impossible to derive from the project, so every session records its `workspace_id` when it is created. The alternative, one workspace per project, was simpler but ruled out by the user.

`PROTOCOL_VERSION` goes to 3. `state.json` is migrated on load: the old workspaces become sections of one workspace, "Personal", and the old session sections are dropped.
