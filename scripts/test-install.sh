#!/usr/bin/env bash
# Tests scripts/install.sh (X58) against a folder made by package-linux.sh:
#
#   scripts/package-linux.sh dist && scripts/test-install.sh dist
#
# On Linux with a systemd user instance it installs for the real user (CI's
# throwaway runner) and checks the service too. Anywhere else, such as on a
# Mac, it uses a scratch home and a `uname` that says Linux, and checks
# everything but systemd.
set -euo pipefail

dist=$(cd "$1" && pwd)
version=$(cat "$dist/VERSION")
work=$(mktemp -d)
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
has() {
  grep -qF -- "$2" <<<"$1" || fail "expected \"$2\" in:
$1"
}
pass() { echo "ok - $*"; }

systemd=0
if [ "$(uname -s)" = Linux ] && systemctl --user show-environment >/dev/null 2>&1; then
  systemd=1
fi
fake="$work/fake"
mkdir -p "$fake"
fake_uname() {
  printf '#!/bin/sh\necho "%s"\n' "$1" >"$fake/uname"
  chmod +x "$fake/uname"
}
if [ "$systemd" = 0 ]; then
  export HOME="$work/home"
  mkdir -p "$HOME"
  fake_uname "Linux x86_64"
fi
# The release download, served from $dist: `curl -fsSL -o <file> <url>`.
printf '#!/bin/sh\ncp "%s/$(basename "$4")" "$3"\n' "$dist" >"$fake/curl"
# This machine on the tailnet, as `tailscale status --json` starts.
printf '#!/bin/sh\necho "{"\necho "  \\"Self\\": {"\necho "    \\"HostName\\": \\"Build Box\\","\necho "    \\"DNSName\\": \\"build-box.tail1234.ts.net.\\","\n' >"$fake/tailscale"
# Lingering cannot be turned on (no polkit, say).
printf '#!/bin/sh\ncase "$1" in show-user) echo "Linger=no" ;; *) exit 1 ;; esac\n' >"$fake/loginctl"
chmod +x "$fake/curl" "$fake/tailscale" "$fake/loginctl"
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"
unset MOONLET_HOME MOONLET_SOCK
# Tailnet access listens on loopback, as in the e2e tests (X39). A daemon
# that systemd starts gets the user manager's environment, not ours.
export MOONLET_MOBILE_ADDRS=127.0.0.1
if [ "$systemd" = 1 ]; then
  systemctl --user set-environment MOONLET_MOBILE_ADDRS=127.0.0.1
fi
bin="$HOME/.moonlet/bin"
cleanup() {
  "$bin/moonletd" stop >/dev/null 2>&1 || true
  if [ "$systemd" = 1 ]; then
    systemctl --user unset-environment MOONLET_MOBILE_ADDRS || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

run_install() {
  PATH="$fake:$PATH" sh "$dist/install.sh" --from "$dist" --no-pair "$@" 2>&1
}

# A fresh install, as published: downloaded, not --from.
out=$(PATH="$fake:$PATH" sh "$dist/install.sh" --no-pair 2>&1) || fail "install failed: $out"
has "$out" "moonlet $version for Linux x86_64"
has "$out" "✓ Downloaded and checked moonletd and moonlet"
has "$out" "✓ Installed in ~/.moonlet/bin"
has "$out" "✓ Tailnet access is on: Listening on 127.0.0.1:"
has "$out" "Pair a Mac: run ~/.moonlet/bin/moonletd pair, and add the host build-box on the Mac."
[ -z "$(ls -A "$TMPDIR")" ] || fail "left behind in TMPDIR: $(ls -A "$TMPDIR")"
[ "$("$bin/moonletd" --version)" = "moonletd $version" ] || fail "wrong moonletd: $("$bin/moonletd" --version)"
if [ "$systemd" = 1 ]; then
  has "$out" "✓ moonletd runs as a systemd user service and starts at boot"
  has "$out" "moonletd will stop when you log out. To keep it running, ask an administrator to run: sudo loginctl enable-linger $(id -un)"
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/moonletd.service"
  expected="[Unit]
Description=moonlet daemon
After=network-online.target

[Service]
Type=notify
NotifyAccess=all
ExecStart=$(cd "$bin" && pwd -P)/moonletd daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target"
  [ "$(cat "$unit")" = "$expected" ] || fail "unit: $(cat "$unit")"
  [ "$(systemctl --user is-active moonletd)" = active ] || fail "the unit is not active"
else
  has "$out" "moonletd is running, but nothing will start it after a reboot."
fi
pass "installs, starts the daemon and turns on tailnet access"

# A damaged download changes nothing.
bad="$work/bad"
cp -R "$dist" "$bad"
# One byte changed: written as a fixed one, it may already be that byte.
tgz="$bad/moonlet-linux-x86_64.tar.gz"
byte=$(dd if="$tgz" bs=1 skip=100 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
printf "\\$(printf '%03o' $(((byte + 1) % 256)))" | dd of="$tgz" bs=1 seek=100 conv=notrunc 2>/dev/null
before=$(cksum <"$bin/moonletd")
if out=$(PATH="$fake:$PATH" sh "$bad/install.sh" --from "$bad" --no-pair --force 2>&1); then
  fail "a damaged archive installed: $out"
fi
has "$out" "The download of moonlet-linux-x86_64.tar.gz is damaged (checksum mismatch). Nothing was changed."
[ "$(cksum <"$bin/moonletd")" = "$before" ] || fail "moonletd changed"
pass "refuses a damaged download"

# Running it again with the same version does nothing.
out=$(run_install) || fail "second install failed: $out"
has "$out" "moonlet $version is already installed."
pass "says when this version is already installed"

# An update keeps a running session.
term=$("$bin/moonlet" rpc terminal.create "{\"cwd\":\"$work\",\"command\":[\"sleep\",\"600\"]}")
id=$(sed -n 's/.*"id": *\([0-9]*\).*/\1/p' <<<"$term" | head -1)
pid=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' <<<"$term" | head -1)
old_daemon=$("$bin/moonletd" status | sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' | head -1)
out=$(run_install --force) || fail "update failed: $out"
list=$("$bin/moonlet" rpc terminal.list '{}')
has "$(tr -d ' \n' <<<"$list")" "\"id\":$id,"
has "$(tr -d ' \n' <<<"$list")" "\"pid\":$pid,"
new_daemon=$("$bin/moonletd" status | sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' | head -1)
[ "$new_daemon" != "$old_daemon" ] || fail "the daemon was not replaced"
if [ "$systemd" = 1 ]; then
  [ "$(systemctl --user is-active moonletd)" = active ] || fail "the unit stopped during the update"
  [ "$(systemctl --user show -p MainPID --value moonletd)" = "$new_daemon" ] || fail "systemd does not follow the new daemon"
fi
pass "updates in place and keeps the session"

# Uninstall keeps the data.
out=$(run_install --uninstall) || fail "uninstall failed: $out"
has "$out" "Removed moonlet. Your data is still in ~/.moonlet; delete it with: rm -rf ~/.moonlet"
[ ! -e "$bin/moonletd" ] && [ ! -e "$bin/moonlet" ] || fail "binaries left behind"
[ -e "$HOME/.moonlet/mobile.json" ] || fail "data removed"
if [ "$systemd" = 1 ]; then
  [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/moonletd.service" ] || fail "unit left behind"
fi
pass "uninstalls and keeps ~/.moonlet"

# Without Tailscale, the install still works and says how to pair later.
if [ "$systemd" = 0 ]; then
  out=$(HOME="$work/home2" MOONLET_MOBILE_ADDRS="" run_install) || fail "install without Tailscale failed: $out"
  has "$out" "Tailscale is not running on this machine. Start it, then run: ~/.moonlet/bin/moonletd pair"
  HOME="$work/home2" "$work/home2/.moonlet/bin/moonletd" stop >/dev/null 2>&1 || true
  pass "installs without Tailscale and says how to pair later"
fi

# A cloud machine (X63) connects out: tailnet access stays off.
if [ "$systemd" = 0 ]; then
  out=$(HOME="$work/home3" run_install --no-listen) || fail "install with --no-listen failed: $out"
  has "$out" "Tailnet access stays off: this machine connects to its central host."
  if grep -q '"enabled": *true' "$work/home3/.moonlet/mobile.json" 2>/dev/null; then
    fail "tailnet access turned on: $(cat "$work/home3/.moonlet/mobile.json")"
  fi
  HOME="$work/home3" "$work/home3/.moonlet/bin/moonletd" stop >/dev/null 2>&1 || true
  pass "leaves tailnet access off with --no-listen"
fi

# A machine without curl or wget is told which it needs.
bare="$work/bare"
mkdir -p "$bare"
# The faked uname on a Mac; on Linux the real one.
if [ -x "$fake/uname" ]; then cp "$fake/uname" "$bare/"; else ln -s "$(command -v uname)" "$bare/uname"; fi
for tool in tar sha256sum shasum; do
  p=$(command -v "$tool" || true)
  if [ -n "$p" ]; then ln -s "$p" "$bare/$tool"; fi
done
out=$(PATH="$bare" /bin/sh "$dist/install.sh" --no-pair 2>&1) && fail "installed without curl or wget"
has "$out" "moonlet's installer needs curl or wget."
pass "names the download tool it needs"

# Other systems get a clear message.
fake_uname "Darwin arm64"
out=$(run_install) && fail "installed on macOS"
has "$out" "On a Mac, install moonlet.app from https://github.com/1devstudio/moonlet/releases/latest."
fake_uname "FreeBSD amd64"
out=$(run_install) && fail "installed on FreeBSD"
has "$out" "moonlet runs on Linux x86_64 and aarch64, not FreeBSD amd64."
pass "names the systems it does not install on"
