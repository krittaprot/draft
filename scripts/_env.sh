# Shared settings for the deploy scripts. Sourced, not run.
cd "$(dirname "$0")/.."
[[ -f deploy/deploy.env ]] && source deploy/deploy.env
for key in LABEL HOSTNAME PORT METRICS_PORT TUNNEL NODE NEON_AUTH_URL ALLOWED_EMAILS TOKEN_LOGIN; do
  public="DRAFT_$key"
  [[ -z "${!public:-}" ]] || printf -v "TANDEM_$key" '%s' "${!public}"
done
TANDEM_LABEL=${TANDEM_LABEL:-com.draft}
TANDEM_PORT=${TANDEM_PORT:-3290}
TANDEM_METRICS_PORT=${TANDEM_METRICS_PORT:-20290}
TANDEM_TUNNEL=${TANDEM_TUNNEL:-draft}
APP_HOME=${DRAFT_HOME:-"$HOME/.local/share/draft"}
LOGS=${DRAFT_LOGS:-"$HOME/Library/Logs/Draft"}
if [[ -z "${DRAFT_HOME:-}" && -d "$HOME/.local/share/tandem/releases" ]]; then
  APP_HOME="$HOME/.local/share/tandem"
  LOGS=${DRAFT_LOGS:-"$HOME/Library/Logs/Tandem"}
fi
AGENTS="$HOME/Library/LaunchAgents"
SERVER_LABEL="$TANDEM_LABEL.server"
TUNNEL_LABEL="$TANDEM_LABEL.tunnel"
loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
