#!/usr/bin/env bash
# Builds static Linux helpers (jauntd + jaunt) for remote hosts and places
# them where the app bundle picks them up (src-tauri/remote/<name>-<triple>).
#
#   scripts/build-remote.sh                      # both x86_64 and aarch64
#   scripts/build-remote.sh x86_64-unknown-linux-musl
#
# Needs cargo-zigbuild (brew install zig && cargo install cargo-zigbuild).
set -euo pipefail
cd "$(dirname "$0")/.."

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)
fi

if ! command -v cargo-zigbuild >/dev/null; then
  echo "cargo-zigbuild not found. Install it with: brew install zig && cargo install cargo-zigbuild" >&2
  exit 1
fi

out=apps/desktop/src-tauri/remote
mkdir -p "$out"
for t in "${targets[@]}"; do
  rustup target add "$t" >/dev/null
  cargo zigbuild --release --target "$t" -p jauntd -p jaunt-cli
  for bin in jauntd jaunt; do
    cp "target/$t/release/$bin" "$out/$bin-$t"
    shasum -a 256 "$out/$bin-$t"
  done
done
