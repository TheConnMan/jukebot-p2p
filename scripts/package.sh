#!/usr/bin/env bash
# Zip the committed extension files. The array below is the only ship list.
set -euo pipefail
cd "$(dirname "$0")/.."

SHIPPED=(
  manifest.json
  background.js
  offscreen.html
  offscreen.js
  content.js
  popup.html
  popup.js
  sidepanel.html
  sidepanel.js
  youtube.js
  vendor/trystero.js
  icon16.png
  icon48.png
  icon128.png
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${SHIPPED[@]}"
  exit 0
fi

python3 - "${SHIPPED[@]}" << 'PY'
import json, re, sys
from pathlib import Path

shipped = sys.argv[1:]
missing = []

def want(path):
    path = path.split("?", 1)[0].split("#", 1)[0]
    if not path or path.startswith(("/", "http:", "https:", "data:", "chrome:")):
        return
    if path.startswith("./"):
        path = path[2:]
    if path not in shipped:
        missing.append(path)

manifest = json.loads(Path("manifest.json").read_text())

def walk(node):
    if isinstance(node, dict):
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
    elif isinstance(node, str) and re.search(r"\.(js|html|css|png|json)$", node):
        want(node)

walk(manifest)

for html in Path(".").glob("*.html"):
    text = html.read_text()
    for match in re.finditer(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", text):
        want(match.group(1))

for js in ("background.js", "offscreen.js", "content.js", "popup.js", "sidepanel.js", "youtube.js"):
    text = Path(js).read_text()
    for match in re.finditer(r"""from\s+["'](\.[^"']+)["']""", text):
        want(match.group(1))

if missing:
    print("referenced files missing from the ship list:", file=sys.stderr)
    for path in sorted(set(missing)):
        print(f"  {path}", file=sys.stderr)
    sys.exit(1)
PY

version="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
mkdir -p dist
out="dist/jukebot-p2p-${version}.zip"
rm -f "$out"
git archive --format=zip --output="$out" HEAD -- "${SHIPPED[@]}"
echo "$out"
