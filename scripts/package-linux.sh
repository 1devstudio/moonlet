#!/usr/bin/env bash
# Packages the Linux helpers for a release (X58): one archive per
# architecture holding moonletd and moonlet, SHA256SUMS, and install.sh with
# the version written in.
#
#   scripts/package-linux.sh <out-dir> [<helpers-dir>]
#
# The helpers are named <binary>-<triple>, as scripts/build-remote.sh leaves
# them in apps/desktop/src-tauri/remote (the default).
set -euo pipefail
cd "$(dirname "$0")/.."

out=$1
src=${2:-apps/desktop/src-tauri/remote}
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -n 1)

mkdir -p "$out"
rm -f "$out"/moonlet-linux-*.tar.gz "$out/SHA256SUMS"
for pair in x86_64:x86_64-unknown-linux-musl aarch64:aarch64-unknown-linux-musl; do
  arch=${pair%%:*}
  triple=${pair#*:}
  [ -f "$src/moonletd-$triple" ] || continue
  tmp=$(mktemp -d)
  cp "$src/moonletd-$triple" "$tmp/moonletd"
  cp "$src/moonlet-$triple" "$tmp/moonlet"
  chmod 755 "$tmp/moonletd" "$tmp/moonlet"
  tar -czf "$out/moonlet-linux-$arch.tar.gz" -C "$tmp" moonletd moonlet
  rm -rf "$tmp"
done
ls "$out"/moonlet-linux-*.tar.gz >/dev/null 2>&1 || {
  echo "no Linux helpers in $src; run scripts/build-remote.sh first" >&2
  exit 1
}
(
  cd "$out"
  if command -v sha256sum >/dev/null; then sha256sum moonlet-linux-*.tar.gz; else shasum -a 256 moonlet-linux-*.tar.gz; fi
) >"$out/SHA256SUMS"
# Only the assignment: the script's own check for an unversioned copy
# compares against the placeholder and must keep it.
sed "s/^MOONLET_VERSION=\"@VERSION@\"\$/MOONLET_VERSION=\"$version\"/" scripts/install.sh >"$out/install.sh"
grep -q "^MOONLET_VERSION=\"$version\"\$" "$out/install.sh" || {
  echo "could not write the version into install.sh" >&2
  exit 1
}
echo "$version" >"$out/VERSION"
