#!/usr/bin/env bash
# Build the native messaging host in release mode and place it where Tauri expects a sidecar
# (apps/desktop/src-tauri/binaries/vaultlet-host-<target triple>).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
cargo build --release -p vaultlet-host --manifest-path "$ROOT/Cargo.toml"
mkdir -p "$ROOT/apps/desktop/src-tauri/binaries"
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe";; esac
cp "$ROOT/target/release/vaultlet-host$EXT" "$ROOT/apps/desktop/src-tauri/binaries/vaultlet-host-$TRIPLE$EXT"
echo "sidecar ready: binaries/vaultlet-host-$TRIPLE$EXT"
