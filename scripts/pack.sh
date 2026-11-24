#!/usr/bin/env bash
# Build the app and pack what the computer needs to run it (no secrets, no node_modules).
# Usage: scripts/pack.sh [output.tgz]
# On the computer: scripts/install-on-computer.sh <the .tgz> does the rest (it is also inside the pack).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-hq-app.tgz}"
rm -rf server/dist web/dist
npm run build
# HeyZubi for Windows: the tray app (desktop/), offered in Settings › Windows app. Left out where .NET isn't installed.
if command -v dotnet >/dev/null 2>&1; then
  dotnet publish desktop -c Release -nologo -v quiet -o desktop/dist >/dev/null
  mkdir -p web/dist/downloads
  cp desktop/dist/HeyZubi.exe web/dist/downloads/HeyZubi.exe
  ver=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' desktop/HeyZubi.csproj)
  size=$(wc -c < web/dist/downloads/HeyZubi.exe | tr -d ' ')
  sha=$(sha256sum web/dist/downloads/HeyZubi.exe | cut -d' ' -f1)
  printf '{"version":"%s","size":%s,"sha256":"%s","builtAt":"%s"}\n' "$ver" "$size" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > web/dist/downloads/heyzubi-windows.json
  echo "bundled HeyZubi for Windows $ver ($size bytes)"
else
  echo "dotnet not found: the Windows app download is left out of this pack"
fi
tar -czf "$out" \
  package.json package-lock.json .env.example \
  server/package.json server/dist server/box \
  web/package.json web/dist \
  scripts/install-on-computer.sh scripts/add-hq-to-hermes.py scripts/sign-in-link.sh
echo "packed $(du -h "$out" | cut -f1) -> $out"
