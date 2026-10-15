#!/usr/bin/env bash
# Tests, builds and publishes a new release to ~/.local/share/tandem/releases, then points
# ~/.local/share/tandem/current at it and restarts the server job if it is installed.
# Roll back with: ln -sfn "$(readlink ~/.local/share/tandem/previous)" ~/.local/share/tandem/current
# and restart the server job.
set -euo pipefail
source "$(dirname "$0")/_env.sh"
KEEP=5

pnpm test

STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
REL="$APP_HOME/releases/$STAMP"
mkdir -p "$REL/node_modules/@resvg"
cp -R dist package.json "$REL/"
for pkg in node_modules/.pnpm/@resvg+resvg-js*/node_modules/@resvg/*; do
  name=$(basename "$pkg")
  [[ -d "$REL/node_modules/@resvg/$name" ]] || cp -RL "$pkg" "$REL/node_modules/@resvg/$name"
done

[[ -L "$APP_HOME/current" ]] && ln -sfn "$(readlink "$APP_HOME/current")" "$APP_HOME/previous"
ln -sfn "$REL" "$APP_HOME/current"

current=$(readlink "$APP_HOME/current"); previous=$(readlink "$APP_HOME/previous" 2>/dev/null || true)
ls -1d "$APP_HOME"/releases/*/ | sed 's:/$::' | sort -r | tail -n +$((KEEP + 1)) | while read -r dir; do
  if [[ "$dir" != "$current" && "$dir" != "$previous" ]]; then rm -rf "$dir"; fi
done

echo "Released $STAMP -> $REL"
if loaded "$SERVER_LABEL"; then
  launchctl kickstart -k "gui/$(id -u)/$SERVER_LABEL"
  sleep 1
  curl -fsS "http://127.0.0.1:$TANDEM_PORT/healthz" && echo
else
  echo "Server job $SERVER_LABEL is not installed. Install it with scripts/install-service.sh"
fi
