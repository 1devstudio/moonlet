#!/usr/bin/env bash
# Signs the Linux archives of a release with the updater key (X69), so a host
# can check an update it downloads, then checks each signature with the
# moonletd the release ships.
#
#   scripts/sign-linux.sh <dir> <moonletd>
#
# TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD hold the
# key, as for the app's updater archive.
set -euo pipefail
cd "$(dirname "$0")/.."

dir=$1
moonletd=$2
shopt -s nullglob
archives=("$dir"/moonlet-linux-*.tar.gz)
[ ${#archives[@]} -gt 0 ] || {
  echo "no Linux archives in $dir" >&2
  exit 1
}
for f in "${archives[@]}"; do
  rm -f "$f.sig"
  pnpm --filter @moonlet/desktop exec tauri signer sign "$(realpath "$f")" >/dev/null
  [ -f "$f.sig" ] || {
    echo "$f.sig was not written" >&2
    exit 1
  }
  "$moonletd" verify-release "$f"
  echo "signed $(basename "$f")"
done
