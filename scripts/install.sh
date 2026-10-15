#!/usr/bin/env bash
# Installs Tandem for this user: builds Tandem.app into ~/Applications and puts the `tandem`
# command in ~/.local/bin. Starts nothing; open Tandem.app (or run `tandem serve`) when you want it.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Tandem needs Node.js 20+ (brew install node)."; exit 1; }
command -v pnpm >/dev/null || { echo "Tandem builds with pnpm (npm install -g pnpm)."; exit 1; }

pnpm install --frozen-lockfile
./scripts/build-app.sh
mkdir -p "$HOME/Applications" "$HOME/.local/bin"
rm -rf "$HOME/Applications/Tandem.app"
cp -R build/Tandem.app "$HOME/Applications/Tandem.app"

cat > "$HOME/.local/bin/tandem" <<'SH'
#!/bin/sh
exec node "$HOME/Applications/Tandem.app/Contents/Resources/server/dist/server.js" "$@"
SH
chmod +x "$HOME/.local/bin/tandem"

echo
echo "Installed ~/Applications/Tandem.app and ~/.local/bin/tandem"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the tandem command.";; esac
echo "Next: open Tandem.app, then connect agents with: tandem connect claude | codex | opencode"
