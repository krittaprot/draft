#!/usr/bin/env bash
# Installs the always-on server as a launchd job (<label>.server) running the current release.
# Run scripts/deploy.sh first. Remove with: launchctl bootout gui/$(id -u)/<label>.server
set -euo pipefail
source "$(dirname "$0")/_env.sh"

[[ -e "$APP_HOME/current/dist/server.js" ]] || { echo "No release yet. Run scripts/deploy.sh first."; exit 1; }
NODE=${TANDEM_NODE:-$(command -v node || true)}
[[ -x "$NODE" ]] || { echo "Node not found. Set TANDEM_NODE in deploy/deploy.env."; exit 1; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
PUBLIC_URL=${TANDEM_HOSTNAME:+https://$TANDEM_HOSTNAME}
PUBLIC_URL=${PUBLIC_URL:-http://127.0.0.1:$TANDEM_PORT}
mkdir -p "$LOGS" "$APP_HOME/data" "$AGENTS"
PLIST="$AGENTS/$SERVER_LABEL.plist"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$SERVER_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$APP_HOME/current/dist/server.js</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>TANDEM_PORT</key><string>$TANDEM_PORT</string>
		<key>TANDEM_HOST</key><string>127.0.0.1</string>
		<key>TANDEM_DATA</key><string>$APP_HOME/data</string>
		<key>TANDEM_PUBLIC_URL</key><string>$PUBLIC_URL</string>
		<key>TANDEM_NEON_AUTH_URL</key><string>${TANDEM_NEON_AUTH_URL:-}</string>
		<key>TANDEM_ALLOWED_EMAILS</key><string>${TANDEM_ALLOWED_EMAILS:-}</string>
		<key>TANDEM_TOKEN_LOGIN</key><string>${TANDEM_TOKEN_LOGIN:-}</string>
	</dict>
	<key>WorkingDirectory</key><string>$APP_HOME</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ProcessType</key><string>Background</string>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>$LOGS/server.out.log</string>
	<key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
</dict>
</plist>
PLIST

loaded "$SERVER_LABEL" && launchctl bootout "gui/$(id -u)/$SERVER_LABEL" || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$TANDEM_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "http://127.0.0.1:$TANDEM_PORT/healthz" && echo
echo "Installed $SERVER_LABEL with $NODE, public URL $PUBLIC_URL"
[[ -f "$APP_HOME/data/owner-token" ]] && echo "Owner token: $APP_HOME/data/owner-token"
