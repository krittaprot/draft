#!/usr/bin/env bash
# Publishes the server at https://$TANDEM_HOSTNAME through its own Cloudflare tunnel and installs
# the <label>.tunnel launchd job. Needs `cloudflared tunnel login` done for the hostname's zone.
# Safe to re-run. Remove with: launchctl bootout gui/$(id -u)/<label>.tunnel
set -euo pipefail
source "$(dirname "$0")/_env.sh"
HOST=${1:-${TANDEM_HOSTNAME:-}}
[[ -n "$HOST" ]] || { echo "usage: scripts/setup-tunnel.sh <hostname> (or set TANDEM_HOSTNAME in deploy/deploy.env)"; exit 1; }
CF=$(command -v cloudflared) || { echo "Install cloudflared first: brew install cloudflared"; exit 1; }

# with several zones, ~/.cloudflared/cert-<domain>.pem holds the origin cert for <domain>.<tld>
ZONE=$(awk -F. '{print $(NF-1)}' <<<"$HOST")
CERT="$HOME/.cloudflared/cert-$ZONE.pem"
[[ -f "$CERT" ]] || CERT="$HOME/.cloudflared/cert.pem"
export TUNNEL_ORIGIN_CERT="$CERT"

ID=$("$CF" tunnel list --output json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s||'[]').find(t=>t.name===process.argv[1]&&(!t.deleted_at||t.deleted_at.startsWith('0001-')));console.log(t?t.id:'')})" "$TANDEM_TUNNEL")
if [[ -z "$ID" ]]; then
  "$CF" tunnel create "$TANDEM_TUNNEL"
  ID=$("$CF" tunnel list --output json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(t=>t.name===process.argv[1]).id))" "$TANDEM_TUNNEL")
fi
"$CF" tunnel route dns "$TANDEM_TUNNEL" "$HOST" || echo "(DNS route already exists or needs a manual check)"

mkdir -p "$APP_HOME" "$LOGS" "$AGENTS"
cat > "$APP_HOME/cloudflared.yml" <<YML
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
metrics: 127.0.0.1:$TANDEM_METRICS_PORT
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$TANDEM_PORT
    originRequest:
      connectTimeout: 10s
      keepAliveTimeout: 90s
  - service: http_status:404
YML

PLIST="$AGENTS/$TUNNEL_LABEL.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$TUNNEL_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$CF</string><string>--no-autoupdate</string><string>tunnel</string>
		<string>--config</string><string>$APP_HOME/cloudflared.yml</string><string>run</string><string>$ID</string>
	</array>
	<key>WorkingDirectory</key><string>$APP_HOME</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ProcessType</key><string>Background</string>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>$LOGS/tunnel.out.log</string>
	<key>StandardErrorPath</key><string>$LOGS/tunnel.err.log</string>
</dict>
</plist>
PLIST
loaded "$TUNNEL_LABEL" && launchctl bootout "gui/$(id -u)/$TUNNEL_LABEL" || true
for attempt in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && break
  [[ $attempt -lt 5 ]] || exit 1
  sleep 1
done
echo "Tunnel $TANDEM_TUNNEL ($ID) -> https://$HOST. Check: curl https://$HOST/healthz"
echo "If TANDEM_PUBLIC_URL changed, re-run scripts/install-service.sh so share links use https://$HOST."
