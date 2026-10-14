# moonlet phone app

The iPhone app of moonlet ([X40](../../docs/specs/X40-mobile-app.md)). It pairs with the daemon on your Mac and reaches it over Tailscale ([X39](../../docs/specs/X39-phone-pairing-and-link.md), [ADR 0008](../../docs/adr/0008-phone-link-over-tailscale.md)). It shares the desktop app's design tokens and logic through the `@desktop` alias (`../desktop/src`), and its Rust core uses `crates/moonlet-link` like the desktop does.

## On the Mac, for development

The same app builds for macOS in a 390 × 844 window, without Xcode:

```sh
pnpm mobile
```

To pair it, turn on Settings › Mobile in the desktop app (or a scratch daemon), click **Pair a phone**, copy the link and paste it into the app.

## On the iPhone

You need Xcode (selected with `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`), CocoaPods (`brew install cocoapods`), the Rust targets `aarch64-apple-ios` and `aarch64-apple-ios-sim`, an Apple ID signed in under Xcode › Settings › Accounts with its team id in `APPLE_DEVELOPMENT_TEAM`, and Tailscale on both the Mac and the iPhone.

```sh
pnpm mobile:ios                                     # pick your iPhone when asked
pnpm --filter @moonlet/mobile tauri ios dev "iPhone 18 Pro"   # or a simulator, no signing needed
```

The Xcode project in `src-tauri/gen/apple` is committed: it holds the app icon (from `src-tauri/icons/source/icon-ios.svg`) and the launch screen (`LaunchScreen.storyboard` and the `LaunchLogo` image, laid out as `src/lib/splash.ts` says). `tauri ios init` would write Tauri's defaults over them; after running it, put them back with `git checkout -- src-tauri/gen/apple`.

With RVM, Homebrew's `pod` fails to find its gems (`Could not find 'nkf'`); run the Tauri commands with `env -u GEM_PATH -u GEM_HOME`.

With a free Apple ID, the app installed on the phone stops opening after 7 days; run `pnpm mobile:ios` again. TestFlight and push notifications need a paid Apple Developer account.

## Tests

```sh
pnpm --filter @moonlet/mobile test   # the screens' logic (src/lib)
cargo test -p moonlet-mobile         # pairing and connections against a fake Mac
```
