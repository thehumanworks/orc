#!/usr/bin/env bash
# Refresh nix/hashes.json after bun.lock changes. The npm dependencies are a fixed-output
# derivation (bun install from bun.lock): build it with a placeholder hash, take the real
# hash from Nix's "hash mismatch" error and write it back. Run from anywhere in the repo:
#
#   nix run .#update-deps-hash     (or: nix/update-deps-hash.sh)
#
# then commit nix/hashes.json. The dependencies are installed for every platform, so the
# hash from any system is the hash for all of them.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
file=nix/hashes.json
if [ ! -f flake.nix ] || [ ! -f "$file" ]; then
  echo "update-deps-hash: $root is not the orc repository (no flake.nix or $file)" >&2
  exit 1
fi

# Tell Nix a shallow clone is shallow: in a git worktree of a shallow repository it cannot
# tell, and then fails on the missing history once the tree is clean.
ref=.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then ref='.?shallow=1'; fi

tmp="$(mktemp -d)"
cp "$file" "$tmp/hashes.json"
updated=0
# On any failure or interrupt, put the original file back.
trap '[ "$updated" = 1 ] || cp "$tmp/hashes.json" "$file"; rm -rf "$tmp"' EXIT

write() { printf '{\n  "node_modules": "%s"\n}\n' "$1" > "$file"; }

old="$(sed -n 's/.*"node_modules": *"\([^"]*\)".*/\1/p' "$tmp/hashes.json")"
write "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
echo "update-deps-hash: building the npm dependencies to learn their hash..." >&2
if nix build --no-link -L "$ref#orc.node_modules" 2>&1 | tee "$tmp/log" >&2; then
  echo "update-deps-hash: the build passed with a placeholder hash; nothing written" >&2
  exit 1
fi
# The "got:" line that follows the orc-node-modules hash mismatch.
new="$(sed -n "/hash mismatch in fixed-output derivation '.*-orc-node-modules-/,/got:/s|.*got: *\(sha256-[A-Za-z0-9+/=]*\).*|\1|p" "$tmp/log" | tail -n 1)"
if [ -z "$new" ]; then
  echo "update-deps-hash: the build failed before a hash mismatch (log above); $file unchanged" >&2
  exit 1
fi

write "$new"
nix build --no-link "$ref#orc.node_modules"
updated=1
if [ "$new" = "$old" ]; then
  echo "update-deps-hash: $file is up to date ($new)"
else
  echo "update-deps-hash: $file: $old -> $new (commit it)"
fi
