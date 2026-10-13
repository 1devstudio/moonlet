# moonlet phone app

The iPhone app of moonlet ([X40](../../docs/specs/X40-mobile-app.md)). It pairs with the daemon on your Mac and reaches it over Tailscale ([X39](../../docs/specs/X39-phone-pairing-and-link.md), [ADR 0008](../../docs/adr/0008-phone-link-over-tailscale.md)). It shares the desktop app's design tokens and logic through the `@desktop` alias (`../desktop/src`), and its Rust core uses `crates/moonlet-link` like the desktop does.

## On the Mac, for development

The same app builds for macOS in a 390 × 844 window, without Xcode:

```sh
pnpm mobile
```

To pair it, turn on Settings › Mobile in the desktop app (or a scratch daemon), click **Pair a phone**, copy the link and paste it into the app.

## On the iPhone

You need Xcode, an Apple ID signed in under Xcode › Settings › Accounts, and Tailscale on both the Mac and the iPhone.

```sh
pnpm --filter @moonlet/mobile tauri ios init   # once: creates src-tauri/gen/apple
pnpm mobile:ios                                # pick your iPhone when asked
```

With a free Apple ID, the app installed on the phone stops opening after 7 days; run `pnpm mobile:ios` again. TestFlight and push notifications need a paid Apple Developer account.

## Tests

```sh
pnpm --filter @moonlet/mobile test   # the screens' logic (src/lib)
cargo test -p moonlet-mobile         # pairing and connections against a fake Mac
```
