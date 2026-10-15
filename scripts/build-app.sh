#!/bin/bash
# Builds build/Easel.app: the native window plus a bundled copy of the server. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d node_modules ]] || pnpm install --frozen-lockfile
node scripts/build.mjs

APP=build/Easel.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server/node_modules/@resvg"
swiftc -O -o build/Easel-arm64 -target arm64-apple-macos13 mac/main.swift
swiftc -O -o build/Easel-x86_64 -target x86_64-apple-macos13 mac/main.swift
lipo -create build/Easel-arm64 build/Easel-x86_64 -output "$APP/Contents/MacOS/Easel"
rm build/Easel-arm64 build/Easel-x86_64
cp mac/Info.plist "$APP/Contents/Info.plist"

# server: the bundle plus resvg (a native module) and its prebuilt binaries for this machine
cp -R dist package.json "$APP/Contents/Resources/server/"
for pkg in node_modules/.pnpm/@resvg+resvg-js*/node_modules/@resvg/*; do
  name=$(basename "$pkg")
  [[ -d "$APP/Contents/Resources/server/node_modules/@resvg/$name" ]] || cp -RL "$pkg" "$APP/Contents/Resources/server/node_modules/@resvg/$name"
done

# the other Mac architecture's prebuilt renderer, so one app runs on both Apple Silicon and Intel
for arch in arm64 x64; do
  dest="$APP/Contents/Resources/server/node_modules/@resvg/resvg-js-darwin-$arch"
  if [[ ! -d "$dest" ]]; then
    mkdir -p build/npm && (cd build/npm && npm pack --silent "@resvg/resvg-js-darwin-$arch@2.6.2" >/dev/null)
    mkdir -p "$dest" && tar -xzf "build/npm/resvg-resvg-js-darwin-$arch-2.6.2.tgz" -C "$dest" --strip-components=1
  fi
done

if [[ ! -f build/AppIcon.icns ]]; then
  ICONSET=build/AppIcon.iconset
  mkdir -p "$ICONSET"
  node --input-type=module -e "
    import { Resvg } from '@resvg/resvg-js'; import fs from 'node:fs';
    const svg = fs.readFileSync('src/web/icon.svg', 'utf8').replace('viewBox=\"0 0 64 64\"', 'viewBox=\"-6 -6 76 76\"');
    fs.writeFileSync('build/icon-1024.png', new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng());"
  for px in 16 32 128 256 512; do
    sips -z $px $px build/icon-1024.png --out "$ICONSET/icon_${px}x${px}.png" >/dev/null
    sips -z $((px * 2)) $((px * 2)) build/icon-1024.png --out "$ICONSET/icon_${px}x${px}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

codesign --force --deep --sign - "$APP"
echo "Built $APP"
