# Tandem

An open-source design canvas you share with your AI agents. Claude Code, Codex, opencode or any MCP client designs on it through MCP; you watch live, edit by hand, leave comments and review every change. Clean-room design inspired by the Figma mental model (frames, auto-layout, layers); no Figma code. MIT licence.

## What's inside

- **For agents (MCP at `/mcp`)**: `create_nodes` builds whole screens from nested trees in one call. There are also `update_nodes`, `move_nodes`, `duplicate_node`, `delete_nodes` and `manage_pages`. `screenshot` returns a PNG the agent can see, plus a share link (PNG, no login, 30 days) to show you in chat. Plus `export` (HTML/CSS with flexbox, or SVG), `upload_image`, comments (`list_comments`, `reply_comment`, `resolve_comment`, `add_comment`), and `get_history` / `restore_revision`. Every change is a revision signed with the agent's token name.
- **For people (web editor and Mac app)**: an infinite canvas with pan/zoom, select, move, resize, and frame/rectangle/ellipse/text tools. There's also a layers panel, an inspector (layout, auto-layout, fill, stroke, shadow, text) and comment pins. History shows who changed what with orange highlights, lets you preview old revisions and restore them. Agent edits appear live with a toast.
- **Node model**: frame (auto-layout row/column, gap, padding, align, justify, hug/fill sizing), rect, ellipse, text (wrapping, weights, Thai/CJK aware), image, path, svg (icons). Gradients, shadows, blur, radius per corner.

## Install on a Mac

Needs Node.js 20+ and pnpm.

```bash
./scripts/install.sh
```

This builds `~/Applications/Tandem.app` and the `tandem` command in `~/.local/bin`. Nothing starts on its own. Open Tandem.app: it uses a Tandem server already running at `http://127.0.0.1:3290`, or starts its bundled one while the app is open. Data lives in `~/.local/share/tandem/data`. To point the app at another server (e.g. your Mac mini), use Tandem → Settings….

## Sign-in

- **People** sign in with Google through [Neon Auth](https://neon.com/docs/auth/overview) when `TANDEM_NEON_AUTH_URL` is set (add your public URL as a trusted domain in Neon). Only emails you allow get in: `tandem member add you@example.com --role owner`, or the People list under Connect agent. Without Neon, people sign in with an access token.
- **Apps with OAuth** (claude.ai and ChatGPT custom connectors, Cursor, MCP Inspector…) only need the URL `https://<host>/mcp`. Tandem follows the MCP authorization spec: discovery, dynamic client registration, authorization code with PKCE, and rotating refresh tokens. A signed-in person approves each app on a consent page, optionally view-only, and the app's changes carry its name. Disconnect apps under Connect agent.
- **Coding agents** use named access tokens (below).

## Connect agents

On the machine running Tandem, one command per agent creates a token named after it and registers the MCP server:

```bash
tandem connect claude      # Claude Code (user scope, HTTP + bearer header)
tandem connect codex       # Codex (stdio bridge; token kept in ~/.config/tandem/credentials.json)
tandem connect opencode    # opencode (global config, HTTP + header)
```

From anywhere else, create a token in the editor (Connect agent) or with `tandem token create <name>`, then:

```bash
claude mcp add --scope user --transport http tandem https://tandem.example.com/mcp --header "Authorization: Bearer <TOKEN>"
opencode mcp add --global tandem --url https://tandem.example.com/mcp --header "Authorization=Bearer <TOKEN>"
TANDEM_TOKEN=<TOKEN> codex mcp add tandem --url https://tandem.example.com/mcp --bearer-token-env-var TANDEM_TOKEN
```

Any MCP client that speaks streamable HTTP works with `https://<host>/mcp` and an `Authorization: Bearer` header. For stdio-only clients, use `tandem stdio --url <server>`.

Tokens: `tandem token create <name> [--role editor|viewer|owner]`, `tandem token list`, `tandem token revoke <name>`. Viewers can read and screenshot but not change anything. The first run creates an `owner` token in `<data>/owner-token`.

## Host it on an always-on Mac (launchd + Cloudflare Tunnel)

Copy `deploy/deploy.env.example` to `deploy/deploy.env` and set the label prefix, hostname and ports. Then:

```bash
./scripts/deploy.sh            # test, build, publish a release to ~/.local/share/tandem/current
./scripts/install-service.sh   # once: launchd job <label>.server (127.0.0.1 only, restarts on crash and at login)
./scripts/setup-tunnel.sh      # once: Cloudflare tunnel + DNS for TANDEM_HOSTNAME + launchd job <label>.tunnel
```

After that, `deploy.sh` alone ships updates (it restarts the server job). Roll back by pointing `current` at `previous` and running `launchctl kickstart -k gui/$(id -u)/<label>.server`. Logs: `~/Library/Logs/Tandem/`.

Security when public: the server only listens on loopback; cloudflared is the only way in. MCP and the API need a bearer token; the editor needs a token login (rate-limited, HttpOnly cookie, CSRF header check). Signed share links expose only one PNG. For an extra layer, put the editor behind Cloudflare Access and bypass `/mcp`, `/r/` and `/healthz` so agents and share links keep working.

## Develop

```bash
pnpm install
pnpm test                       # builds, then end-to-end tests over real MCP clients
node dist/server.js serve --port 3291 --data /tmp/tandem-dev
./scripts/build-app.sh          # build/Tandem.app (universal; bundles both resvg binaries)
```

Layout: `src/shared` (model, layout engine, text metrics, SVG renderer shared by server and browser), `src/server` (store, ops, auth, MCP tools, HTTP), `src/web` (editor), `mac/` (Swift wrapper), `scripts/` (build, install, deploy).

Known limits: text measurement uses Helvetica metrics, so other fonts may wrap slightly differently. Server screenshots use the fonts on the host plus any `.ttf/.otf` dropped into `<data>/fonts`.
