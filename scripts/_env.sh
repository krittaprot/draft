# Shared settings for the deploy scripts. Sourced, not run.
cd "$(dirname "$0")/.."
[[ -f deploy/deploy.env ]] && source deploy/deploy.env
TANDEM_LABEL=${TANDEM_LABEL:-com.tandem}
TANDEM_PORT=${TANDEM_PORT:-3290}
TANDEM_METRICS_PORT=${TANDEM_METRICS_PORT:-20290}
TANDEM_TUNNEL=${TANDEM_TUNNEL:-tandem}
APP_HOME="$HOME/.local/share/tandem"
LOGS="$HOME/Library/Logs/Tandem"
AGENTS="$HOME/Library/LaunchAgents"
SERVER_LABEL="$TANDEM_LABEL.server"
TUNNEL_LABEL="$TANDEM_LABEL.tunnel"
loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
