#!/bin/sh
# Install the API Connect toolkit on macOS from the file you downloaded.
#
# The toolkit is not on npm for v10 and above. It is downloaded from the API
# Manager UI, which means it arrives quarantined by Gatekeeper — and that is
# the step that usually wastes the afternoon, because the error macOS gives is
# about the binary being damaged rather than about quarantine.
#
# Usage:
#   sh scripts/install-apic.sh ~/Downloads/toolkit-mac.zip
#   sh scripts/install-apic.sh ~/Downloads/apic
#
# Installs to ~/.local/bin, which needs no sudo. Add it to PATH if it is not
# there already.

set -eu

SRC="${1:?usage: sh scripts/install-apic.sh <downloaded zip or apic binary>}"
DEST="${APIC_INSTALL_DIR:-$HOME/.local/bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST"

case "$SRC" in
  *.zip)
    printf 'unpacking %s\n' "$SRC"
    unzip -q -o "$SRC" -d "$WORK"
    # The archive layout varies by release, so find the binary rather than
    # assuming a path.
    BIN="$(find "$WORK" -type f \( -name 'apic' -o -name 'apic-slim' -o -name 'apic_*' \) | head -1)"
    [ -n "$BIN" ] || { echo "no apic binary found inside the archive" >&2; exit 1; }
    ;;
  *)
    BIN="$SRC"
    ;;
esac

cp "$BIN" "$DEST/apic"
chmod +x "$DEST/apic"

# The important line. Downloaded binaries carry com.apple.quarantine, and
# macOS reports the result as "damaged and can't be opened", which sends
# people looking for a corrupt download that is not corrupt.
xattr -d com.apple.quarantine "$DEST/apic" 2>/dev/null || true

printf '\ninstalled: %s\n' "$DEST/apic"

if ! command -v apic >/dev/null 2>&1; then
  printf '\n%s is not on PATH. Add it:\n\n    export PATH="%s:$PATH"\n\n' "$DEST" "$DEST"
fi

# `apic version` is a subcommand, not a `--version` flag. Getting this wrong
# makes a working install look like a failed one.
printf 'verifying...\n'
if "$DEST/apic" --help >/dev/null 2>&1; then
  printf 'apic responds.\n\n'
  printf 'On first run it asks you to accept the IBM licence. Run:\n\n'
  printf '    apic version\n\n'
  printf 'and answer the prompt yourself — accepting a vendor licence is not\n'
  printf 'something a script should do on your behalf.\n'
else
  printf '\napic did not run.\n'
  case "$(uname -m)" in
    arm64)
      printf 'This machine is arm64 and the toolkit ships as x86_64, so it needs Rosetta:\n'
      printf '    softwareupdate --install-rosetta\n'
      ;;
  esac
  exit 1
fi
