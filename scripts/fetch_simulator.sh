#!/usr/bin/env bash
# Populate simulator/bin/dstack-simulator.
#
# The binary is ~26 MB and is not committed. It is sourced from a local dstack
# checkout when there is one, and downloaded from a pinned release otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$ROOT_DIR/simulator/bin/dstack-simulator"
VERSION="${DSTACK_SIMULATOR_VERSION:-0.5.4}"
TARGET="x86_64-unknown-linux-musl"

mkdir -p "$(dirname "$DEST")"

if [ -f "$DEST" ]; then
  echo "Already present: $DEST"
  exit 0
fi

for candidate in \
  "$ROOT_DIR/dstack-sim/dstack/sdk/simulator/dstack-simulator" \
  "${DSTACK_CHECKOUT:-}/sdk/simulator/dstack-simulator"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    cp "$candidate" "$DEST"
    chmod +x "$DEST"
    echo "Copied from local checkout: $candidate"
    exit 0
  fi
done

URL="https://github.com/Dstack-TEE/dstack/releases/download/simulator-v${VERSION}/dstack-simulator-${VERSION}-${TARGET}.tar.gz"
echo "Downloading $URL"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP/sim.tar.gz"; then
  cat >&2 <<MSG

Could not download the simulator.

Options:
  1. Clone dstack and point DSTACK_CHECKOUT at it:
       git clone https://github.com/Dstack-TEE/dstack
       DSTACK_CHECKOUT=\$PWD/dstack scripts/fetch_simulator.sh
  2. Set DSTACK_SIMULATOR_VERSION to a release that exists.
  3. Build it: cargo build --release -p dstack-guest-agent-simulator

MSG
  exit 1
fi

tar -xzf "$TMP/sim.tar.gz" -C "$TMP"
found=$(find "$TMP" -name dstack-simulator -type f | head -1)
[ -n "$found" ] || { echo "tarball contained no dstack-simulator binary" >&2; exit 1; }

cp "$found" "$DEST"
chmod +x "$DEST"
echo "Installed: $DEST"
