# X105 — Models from Claude Code

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** agent sessions (X6 structured chats, X54 new-session composer)
- **Related ADRs:** none

## Summary

moonlet's Claude model menus came from a list written into the app: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5. It went out of date with each new model. Fable 5.2 never showed, though picking "Fable 5.1" already ran it: moonlet passes the alias `fable`, and Claude Code resolves it to its newest Fable. X105 takes the menus from Claude Code itself. Claude Code's answer to `initialize` lists every model it offers, with a label, a description, the model an alias resolves to and the effort levels each model supports. The menus show the newest models at the top and the rest under **More models**, and the Effort menu offers only the chosen model's levels.

## User journey

1. The user opens a new session. The Composer's model column lists Opus 5.5, Fable 5.2, Sonnet 5.5 and Haiku 5.5, in Claude Code's order, and a **More models** row.
2. Hovering More models opens the older models: Fable 5.1, Haiku 4.5, Sonnet 5, Opus 5 and so on.
3. They pick Opus 4.6. The Effort column drops Extra high, which Opus 4.6 does not support; an Extra high they had picked becomes High.
4. In a running chat, the footer's model menu shows the same groups, from the list that chat's own Claude reported.
5. On the phone, the model sheet lists the newest models, and **More models** opens the rest in place.

## Behaviour and acceptance criteria

- [x] Claude Code's `initialize` reply gives the chat its models: for each, the value passed to `--model`, the label, the description, the model it resolves to and its effort levels. A reply without `models` leaves the list empty. (`claude.rs` `the_initialize_reply_gives_the_models_claude_code_offers`)
- [x] `claude.models {workspace?}` answers the models Claude Code offers in that workspace's Claude profile (X33). The daemon starts `claude` with the profile's environment, sends only `initialize`, reads the reply and stops it: no message is sent and no conversation is made. (`moonletd/tests/daemon.rs` `claude_models_come_from_claude_codes_initialize_reply`)
- [x] A Claude that ends without answering gives an empty list, not an error, and for a minute after that the daemon answers empty without starting Claude again. (`moonletd/tests/daemon.rs` `claude_models_are_empty_when_claude_does_not_answer`)
- [x] The newest models are the aliases: every value without the `claude-` prefix except `default`, in Claude Code's order. Every other model goes under More models, in Claude Code's order. (`agents.test.ts` "puts the aliases at the top and the pinned models under More models")
- [x] With no list (a daemon from before X105, an older Claude Code, or before the answer), the menu offers Opus, Fable, Sonnet and Haiku without version numbers and no More models. (`agents.test.ts` "falls back to the aliases without versions")
- [x] A model's label is its Claude Code label; a model id the list does not have shows as it is. (`agents.test.ts` "labels a model by Claude Code's name, else by its id")
- [x] The Effort menu offers only the efforts the chosen model lists. A model that lists none has no Effort menu. A model the list does not have, or no list, offers all five; Codex keeps its three. (`agents.test.ts` "offers the efforts the chosen model supports")
- [x] Choosing a model for a new session keeps the chosen effort when the model supports it, else sets High, or none for a model without efforts. (`agents.test.ts` "keeps the effort when the new model supports it, else High")
- [x] Choosing a model in a running chat changes its effort only when the new model lacks it; for a model without efforts the effort stays as it is. (`agents.test.ts` "switches a running chat's model, and its effort only when the new model lacks it")
- [x] The phone's chat footer names the model by the chat's list. (`chatView.test.ts` "names the model by the chat's list (X105)") Its model sheets build their groups with the same `modelMenu`.
- [x] The Composer shows Claude Code's newest models and the older ones under More models. (`models-from-claude-code.e2e.ts` "lists the newest models, the older ones under More models, and the efforts of the chosen one")

## UI

Composer, model column:

```
Model
✓ Opus 5.5
  Fable 5.2
  Sonnet 5.5
  Haiku 5.5
  More models  ›   ──►  Fable 5.1
                        Haiku 4.5
                        Sonnet 5
                        …
```

A model picked from More models shows a check on the More models row too (in the Composer). The chat footer's settings menu gets the same groups, with More models as a submenu. The phone's sheet expands More models in place.

## Protocol and RPCs

- `ChatState.models`: `ClaudeModel[]`, empty until Claude has answered `initialize`.
- `ClaudeModel` `{ value, label, description, resolved, efforts }`. `efforts` is empty for a model without effort levels (`supportsEffort` missing or false).
- `claude.models` `{ workspace?: string }` → `ClaudeModel[]`. Refused for calls forwarded from another member (X68).

## Data and config

The daemon keeps each profile's list in memory, refreshed whenever a chat in that profile starts its Claude. Nothing is written to disk. One Claude at a time is started to ask; it gets 20 seconds to answer, and a host without `claude` answers empty at once. The probe's whole process group is killed when it ends, so nothing it started outlives it.

## Security considerations

The probe runs the user's own `claude` with the same environment a chat in that workspace gets, and sends nothing but `initialize`. `claude.models` is not in the forwarding scope (X68): another member cannot make this host start a Claude.

## Out of scope

- Codex models.
- A list for a project's own `[agents]` commands.
- Showing a model's description in the Composer.

## Test plan

- Unit (`moonlet-core`): parsing the `initialize` reply captured from Claude Code 2.1.325.
- Daemon e2e: `claude.models` with a fake `claude` that answers `initialize`, and with no `claude`.
- Vitest: the menu groups, labels, efforts and fallback, from the captured list; the phone's footer label.
- App e2e: the Composer's model column.

## Open questions

- Claude Code accepts `--effort` for a model without effort levels (Haiku 4.5 answered with `--effort high` on 2.1.325), so a chat's effort is left as it was when it switches to such a model.
