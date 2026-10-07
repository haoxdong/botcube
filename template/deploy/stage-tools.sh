#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
cube_root=$(cd "$script_dir/../.." && pwd)
destination="$cube_root/harness/deepagents/.tool-dist"

rm -rf "$destination"
mkdir -p "$destination/cartridge"
cp -R "$script_dir/bin" "$destination/bin"
cp "$script_dir/tool-package.json" "$destination/package.json"
cp "$script_dir/tool-package-lock.json" "$destination/package-lock.json"
npm ci --ignore-scripts --omit=dev --prefix "$destination"
uv build --wheel "$cube_root/template" --out-dir "$destination/cartridge"

node "$script_dir/stage-browser-tools.mjs" "$destination"
rm -rf "$destination/node_modules"
