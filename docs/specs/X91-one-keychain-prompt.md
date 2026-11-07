# X91 — One Keychain prompt per start: every tracker token in one Keychain item

- **Status:** implemented
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X44 (task trackers)
- **Related ADRs:** [0010 task trackers in the app](../adr/0010-task-trackers-in-the-app.md)

## Summary

Before this change, X44 kept each tracker connection's token in a Keychain item of its own, and read it again on every tracker request. macOS checks access to each item separately. A binary that an item doesn't trust asks for the login password once per item. Dev builds are signed ad hoc, so every rebuild counts as a new app, and so does any build not signed with the Developer ID. With a Linear, a Jira and a ClickUp connection, opening such a build asked for the password three times. Now every token lives in one Keychain item. The app reads it once per start and keeps it in memory, so a start asks once at most. The signed release, once allowed with **Always Allow**, asks no more, across updates too.

## User journey

1. The user has three tracker connections and opens a build the Keychain item doesn't trust yet.
2. macOS asks once: "moonlet wants to use your confidential information stored in "dev.onedevstudio.moonlet.trackers" in your keychain."
3. The user enters the password and clicks **Always Allow**. Tasks mode loads all three boards without asking again. The next start of the same binary doesn't ask at all.

The first start after the update still asks once per old item: moving a token into the one item means reading it. After that, it's one prompt at most.

## Behaviour and acceptance criteria

- [x] All of a Mac's tracker tokens are kept in one Keychain generic password, read once per app start: with three connections and any number of requests, a start reads the Keychain once. (`secrets.rs` three_connections_ask_for_the_keychain_password_once_per_start)
- [x] A token kept in its own item by an earlier version is moved into the one item the first time it's needed, and its old item is deleted. The next start reads only the one item. (`secrets.rs` tokens_kept_one_item_per_connection_move_into_the_one_item)
- [x] Saving or forgetting a token changes the item as it is in the Keychain now, not as this app last read it. A token that another moonlet (a dev build next to the app) saved in the meantime is kept. (`secrets.rs` a_token_another_moonlet_saved_meanwhile_is_kept)
- [x] When the user clicks Cancel at the password prompt, the app asks no more until the user connects or disconnects a tracker, and its tokens read as missing (the connections ask to be reconnected). The item is never overwritten while it can't be read, so no token is lost. (`secrets.rs` cancelling_the_password_prompt_asks_no_more_and_keeps_the_tokens)
- [x] An item of the old kind is read once per start at most: after Cancel at its prompt, that connection's requests don't ask again, and the item stays. (`secrets.rs` cancelling_the_prompt_for_a_token_kept_on_its_own_asks_no_more)
- [x] e2e builds keep using `~/.moonlet/secrets.json` and never prompt. (`secrets.rs` a_file_store_keeps_tokens_private_and_forgets_them)

## UI

No change. The prompt is macOS's own.

## Protocol and RPCs

None.

## Data and config

- Keychain: service `dev.onedevstudio.moonlet.trackers`, account `tokens`, holding a JSON object from connection id to token. Connection ids are `<kind>:<site>`, so no connection's id is `tokens`. A Linear OAuth sign-in's value is still its tokens as JSON, now a string inside the object.
- Items of the old kind (account `<connection id>`) are deleted once their token has moved.

## Security considerations

- The tokens are still in the login Keychain, and the item's access rules are still macOS's, as before: the binary that creates the item is trusted, other binaries ask.
- Tokens are held in the app's memory for as long as it runs. They were already in memory while each request ran.
- One item means one approval covers every connection. That's the point of this change: the user approves this app's access to its own tracker tokens, which already belong together.

## Out of scope

- **Touch ID.** The prompt that macOS shows for login-keychain items takes only the password. Touch ID would need the data protection keychain with an access control. The app would need a keychain entitlement and a Developer ID provisioning profile, and ad-hoc dev builds, the ones that prompt, couldn't use it. The signed release already starts without a prompt.
- **Changes from another moonlet while this one runs.** A token one moonlet refreshes is seen by another only at its next start. Today only Linear OAuth refreshes tokens, and it isn't enabled in any build yet.

## Test plan

- Rust unit tests in `apps/desktop/src-tauri/src/secrets.rs`, against a stand-in Keychain that asks for the password on every read of an item and records each prompt.
- By hand, against the real login Keychain under a throwaway service: `cargo test -p moonlet-app --lib secrets -- --ignored` (`the_keychain_keeps_every_token_in_one_item`: a missing item reads as none, an old item moves into the one item, and both are removed afterwards).
- Manual: run the change in a build with three connections, and check that the first start asks once per old item and the next start asks once.

## Open questions

- None.
