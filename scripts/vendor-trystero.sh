#!/usr/bin/env bash
# Rebuild vendor/trystero.js: Trystero (Nostr signaling) bundled into one ES module.
# The extension itself has no build step; rerun this only to bump Trystero.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-save trystero@"${1:-0.26.0}" esbuild@0.25.12
echo "export {joinRoom, selfId} from 'trystero'" | npx esbuild --bundle --format=esm --minify --outfile=vendor/trystero.js
