#!/bin/sh
# Installs moonlet on a Linux host (X58):
#
#   curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh
#
# Downloads the static moonletd and moonlet of this release, checks their
# SHA-256, installs them in ~/.moonlet/bin, runs the daemon as a systemd user
# service, turns on tailnet access and starts pairing. Running it again
# updates moonlet without ending any session. Never uses sudo.
#
# Options: --no-pair, --no-listen (tailnet access stays off: a cloud
# machine connects to its central host, X63), --force (install even this
# version again), --uninstall, --from <dir> (archives and SHA256SUMS from a
# folder).
#
# Everything runs from main(), called on the last line, so a download cut
# off midway runs nothing.

set -eu

# Written by the release workflow (scripts/package-linux.sh).
MOONLET_VERSION="@VERSION@"
REPO="1devstudio/moonlet"

die() {
  echo "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

need() {
  has "$1" || die "moonlet's installer needs $1."
}

arch() {
  case "$(uname -sm)" in
    "Linux x86_64") echo x86_64 ;;
    "Linux aarch64" | "Linux arm64") echo aarch64 ;;
    Darwin*) die "On a Mac, install moonlet.app from https://github.com/$REPO/releases/latest." ;;
    *) die "moonlet runs on Linux x86_64 and aarch64, not $(uname -sm)." ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# The first label of this machine's MagicDNS name, or its host name.
tailnet_name() {
  name=""
  if command -v tailscale >/dev/null 2>&1; then
    name=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^".]*\)\..*/\1/p' | head -n 1)
  fi
  [ -n "$name" ] || name=$(uname -n | cut -d. -f1)
  echo "$name"
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

uninstall() {
  bin="$HOME/.moonlet/bin"
  if [ -x "$bin/moonletd" ]; then
    if has_systemd; then
      "$bin/moonletd" service uninstall >/dev/null 2>&1 || true
    fi
    "$bin/moonletd" stop >/dev/null 2>&1 || true
  fi
  rm -f "$bin/moonletd" "$bin/moonlet"
  echo "Removed moonlet. Your data is still in ~/.moonlet; delete it with: rm -rf ~/.moonlet"
}

main() {
  from=""
  pair=1
  listen=1
  force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) from=$2; shift 2 ;;
      --no-pair) pair=0; shift ;;
      --no-listen) listen=0; shift ;;
      --force) force=1; shift ;;
      --uninstall) uninstall; return ;;
      *) die "Unknown option $1. Options: --no-pair, --no-listen, --force, --uninstall, --from <dir>." ;;
    esac
  done

  a=$(arch)
  version=$MOONLET_VERSION
  if [ "$version" = "@VERSION@" ]; then
    [ -n "$from" ] && [ -f "$from/VERSION" ] || die "Run the install.sh published with a release."
    version=$(cat "$from/VERSION")
  fi
  need tar
  has sha256sum || has shasum || die "moonlet's installer needs sha256sum or shasum."
  [ -n "$from" ] || has curl || has wget || die "moonlet's installer needs curl or wget."
  echo "moonlet $version for Linux $a"

  bin="$HOME/.moonlet/bin"
  archive="moonlet-linux-$a.tar.gz"
  running=0
  if [ -x "$bin/moonletd" ] && "$bin/moonletd" status >/dev/null 2>&1; then
    running=1
  fi

  if [ "$force" = 0 ] && [ -x "$bin/moonletd" ] && [ "$("$bin/moonletd" --version 2>/dev/null)" = "moonletd $version" ]; then
    echo "moonlet $version is already installed."
    installed=0
  else
    tmp=$(mktemp -d)
    # On a failure; a finished install removes it below.
    trap 'rm -rf "$tmp"' EXIT
    if [ -n "$from" ]; then
      cp "$from/$archive" "$from/SHA256SUMS" "$tmp/"
    else
      base="https://github.com/$REPO/releases/download/v$version"
      fetch "$base/$archive" "$tmp/$archive" || die "Cannot download $base/$archive."
      fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "Cannot download $base/SHA256SUMS."
    fi
    expected=$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
    if [ -z "$expected" ] || [ "$(sha256 "$tmp/$archive")" != "$expected" ]; then
      die "The download of $archive is damaged (checksum mismatch). Nothing was changed."
    fi
    mkdir -p "$tmp/x"
    tar -xzf "$tmp/$archive" -C "$tmp/x" moonletd moonlet
    echo "✓ Downloaded and checked moonletd and moonlet"
    (
      umask 077
      mkdir -p "$bin"
      for b in moonletd moonlet; do
        cp "$tmp/x/$b" "$bin/$b.new"
        chmod 700 "$bin/$b.new"
        mv -f "$bin/$b.new" "$bin/$b"
      done
    )
    echo "✓ Installed in ~/.moonlet/bin"
    rm -rf "$tmp"
    trap - EXIT
    installed=1
  fi

  # A running daemon hands its sessions to the new binary (S3).
  if [ "$running" = 1 ] && [ "$installed" = 1 ]; then
    "$bin/moonletd" upgrade
  fi
  if has_systemd; then
    "$bin/moonletd" service install
    echo "✓ moonletd runs as a systemd user service and starts at boot"
    if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
      loginctl enable-linger 2>/dev/null ||
        echo "moonletd will stop when you log out. To keep it running, ask an administrator to run: sudo loginctl enable-linger $(id -un)"
    fi
  else
    "$bin/moonletd" start
    echo "moonletd is running, but nothing will start it after a reboot."
  fi

  # moonletd takes `tailnet` and `pair` only from the app, or from a login
  # over SSH, at the console or by root (X75): not from a desktop terminal.
  if [ "$listen" = 0 ]; then
    # Off, also when an earlier install turned it on.
    status=$("$bin/moonletd" tailnet off 2>&1) || true
    case "$status" in
      "Only the moonlet app"*)
        echo "Tailnet access may still be on: only the moonlet app, or you over SSH or at the console, may turn it off."
        echo 'Turn it off from this terminal with: sudo runuser -u "$(id -un)" -- ~/.moonlet/bin/moonletd tailnet off'
        ;;
      *) echo "Tailnet access stays off: this machine connects to its central host." ;;
    esac
    return 0
  fi
  if ! status=$("$bin/moonletd" tailnet on 2>&1); then
    case "$status" in
      "Only the moonlet app"*)
        echo "Tailnet access was not turned on: only the moonlet app, or you over SSH or at the console, may turn it on."
        echo "Turn it on and pair this machine from this terminal with:"
        echo '  sudo runuser -u "$(id -un)" -- ~/.moonlet/bin/moonletd tailnet on'
        echo '  sudo runuser -u "$(id -un)" -- ~/.moonlet/bin/moonletd pair'
        echo "or run ~/.moonlet/bin/moonletd tailnet on and pair over SSH or at the console."
        return 0
        ;;
    esac
    die "$status"
  fi
  case "$status" in
    "Tailscale is not running"*)
      echo "Tailscale is not running on this machine. Start it, then run: ~/.moonlet/bin/moonletd pair"
      return 0
      ;;
    *) echo "✓ Tailnet access is on: $status" ;;
  esac

  name=$(tailnet_name)
  if [ "$pair" = 1 ] && [ -t 1 ]; then
    echo
    "$bin/moonletd" pair --name "$name"
    return
  fi
  echo "Pair a Mac: run ~/.moonlet/bin/moonletd pair, and add the host $name on the Mac."
}

main "$@"
