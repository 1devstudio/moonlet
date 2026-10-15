#!/usr/bin/env bash
# Runs a command without the moonlet session's environment, so tests and the
# e2e app never reach the daemon of the session they were started from.
#
#   scripts/clean-env.sh [--scratch-home] <command> [args...]
#
# - Drops every MOONLET_* and JAUNT_* variable (MOONLET_SOCK points at the
#   real daemon; the e2e app merges the parent's environment into its own).
# - Sets TAURI_WEBDRIVER_PORT to 4545 unless given, so a run does not drive
#   another worktree's e2e app on the default 4445.
# - --scratch-home sets MOONLET_HOME to a fresh temp dir: moonlet binaries
#   started without a home move a real ~/.jaunt to ~/.moonlet (X27).
set -euo pipefail

scratch=0
if [[ "${1:-}" == "--scratch-home" ]]; then
  scratch=1
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "usage: scripts/clean-env.sh [--scratch-home] <command> [args...]" >&2
  exit 2
fi

unset_args=()
while IFS='=' read -r name _; do
  [[ "$name" == MOONLET_* || "$name" == JAUNT_* ]] && unset_args+=(-u "$name")
done < <(env)

extra=("TAURI_WEBDRIVER_PORT=${TAURI_WEBDRIVER_PORT:-4545}")
if [[ $scratch -eq 1 ]]; then
  extra+=("MOONLET_HOME=$(mktemp -d "${TMPDIR:-/tmp}/moonlet-home.XXXXXX")")
fi

# A guard against this script itself going wrong: nothing may still point
# at a daemon.
if env ${unset_args[@]+"${unset_args[@]}"} | grep -q '^MOONLET_SOCK='; then
  echo "clean-env: MOONLET_SOCK is still set; refusing to run" >&2
  exit 1
fi

exec env ${unset_args[@]+"${unset_args[@]}"} "${extra[@]}" "$@"
