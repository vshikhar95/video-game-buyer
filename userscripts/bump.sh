#!/bin/sh
# Usage: userscripts/bump.sh <script.user.js> <new-version>
# Sets @version and the ?v= on every @require so Tampermonkey re-fetches the shared files.
set -e
f="$1"; v="$2"
[ -f "$f" ] && [ -n "$v" ] || { echo "usage: $0 <script.user.js> <version>"; exit 1; }
sed -i.bak -E "s|^(// @version +).*|\1$v|; s|(\.js)\?v=[0-9.]+|\1?v=$v|" "$f" && rm "$f.bak"
grep -E "@version|@require" "$f"
