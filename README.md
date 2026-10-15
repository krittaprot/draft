<p align="center"><img src="docs/tandem-icon-minimal.png" width="96" height="96" alt="Draft icon: a white cursor and cyan curve on a navy tile"></p>

<h1 align="center">Draft</h1>

Formerly Tandem. Existing `tandem` commands, repository URL, server address and data paths remain compatible.

<p align="center"><b>The self-hosted design canvas for you and your AI agents.</b><br>
Claude Code, Codex, opencode or any MCP client designs on it. You watch it happen, edit by hand, and review every change.<br>
Runs on your own machine. Your designs stay on your disk.</p>

<p align="center">
<a href="https://github.com/krittaprot/tandem/actions/workflows/ci.yml"><img src="https://github.com/krittaprot/tandem/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1F5FD6" alt="MIT licence"></a>
</p>

![The Draft editor: an agent's latest change outlined in amber on a wallet app design, with the history panel listing revisions by codex and claude-code](src/web/shots/review.png)

## Why Draft

- **Agents get a real canvas.** Over MCP they create whole screens with frames and auto-layout. They take screenshots to check their own work, and share a link so you can see it in chat.
- **You stay in charge.** Every agent edit lands live, outlined in amber with the agent's name. Edit any layer by hand, pin comments the agent reads and answers, and step back through history.
- **It's yours.** Draft is one small Node.js server you run yourself: on a laptop while you work, or on an always-on Mac you reach from anywhere through your own domain. Designs are plain files on your disk, with every revision kept. MIT licensed.

Draft is a clean-room design inspired by the Figma mental model (frames, auto-layout, layers). It contains no Figma code.

## Self-host in a minute

Needs Node.js 20 or newer and pnpm.

```bash
git clone https://github.com/krittaprot/tandem
cd tandem && pnpm install && pnpm build
node dist/server.js serve
```

Open http://127.0.0.1:3290.
- The first run creates an owner key and prints where it's saved (`~/.local/share/tandem/data/owner-token`). Sign in with that key.
- Then connect your agents (below).
- Data lives in `~/.local/share/tandem/data`; change it with `--data DIR` or `TANDEM_DATA`.
- `node dist/server.js --help` lists every command.

The web app installs like a native one: in Safari choose File → Add to Dock, and on iPhone use Share → Add to Home Screen.

### Mac app and the `tandem` command

```bash
./scripts/install.sh
```

This builds `~/Applications/Draft.app` and the `tandem` command in `~/.local/bin`. Nothing starts on its own. Open Draft.app:
- It uses a Draft server already running at `http://127.0.0.1:3290`, or starts its bundled one while the app is open.
- To point it at another server, such as an always-on Mac, use Draft → Settings….

## Connect agents

On the machine running Draft, one command per agent creates a key named after it and registers the MCP server:

```bash
tandem connect claude      # Claude Code (user scope, HTTP + bearer header)
tandem connect codex       # Codex (stdio bridge; key kept in ~/.config/tandem/credentials.json)
tandem connect opencode    # opencode (global config, HTTP + header)
```

Without the installer, run `node dist/server.js connect …` from the repo instead.

From anywhere else, create a key in the editor (Connect agent) or with `tandem token create <name>`, then:

```bash
claude mcp add --scope user --transport http tandem https://tandem.example.com/mcp --header "Authorization: Bearer <TOKEN>"
opencode mcp add --global tandem --url https://tandem.example.com/mcp --header "Authorization=Bearer <TOKEN>"
TANDEM_TOKEN=<TOKEN> codex mcp add tandem --url https://tandem.example.com/mcp --bearer-token-env-var TANDEM_TOKEN
```

- **Other MCP clients:** anything that speaks streamable HTTP works with `https://<host>/mcp` and an `Authorization: Bearer` header. For stdio-only clients, use `tandem stdio --url <server>`.
- **Apps with sign-in** (claude.ai and ChatGPT custom connectors, Cursor, MCP Inspector…) only need the URL `https://<host>/mcp`.
  - They connect with OAuth: you approve each app once on a consent page, optionally as view-only.
  - Each app's changes carry its name.
- **Keys:**
  - `tandem token create <name> [--role editor|viewer|owner]`, `tandem token list`, `tandem token revoke <name>`.
  - Viewers can read and take screenshots but can't change anything.

## What's inside

- **For agents (MCP at `/mcp`):**
  - `create_nodes` builds whole screens from nested trees in one call.
  - Editing: `update_nodes`, `move_nodes`, `duplicate_node`, `delete_nodes`, `manage_pages`.
  - `screenshot` returns a PNG the agent can see, plus a share link (a PNG that opens without sign-in for 30 days) to show you in chat.
  - `export` produces HTML/CSS with flexbox, or SVG. `upload_image` adds images.
  - Comments: `list_comments`, `add_comment`, `reply_comment`, `resolve_comment`.
  - History: `get_history`, `restore_revision`.
  - Every change is a revision signed with the agent's name.
- **For people (web editor, installable web app and Mac app):**
  - An infinite canvas with pan and zoom.
  - Select, move and resize, plus frame, rectangle, ellipse and text tools.
  - A layers panel and an inspector for layout, auto-layout, fill, stroke, shadow and text.
  - Comment pins.
  - History that shows who changed what, with amber outlines, and lets you preview and restore old revisions.
  - Live toasts when an agent edits.
- **Node model:**
  - frame: auto-layout row/column, gap, padding, align, justify, hug/fill sizing.
  - rect, ellipse, image, path, and svg (for icons).
  - text: wrapping, weights, Thai/CJK aware.
  - Gradients, shadows, blur, and radius per corner.

## Put it online (always-on Mac + your own domain)

Run Draft on a Mac that stays on, and reach it from anywhere through a Cloudflare Tunnel. No open ports needed.

Copy `deploy/deploy.env.example` to `deploy/deploy.env` and set the label prefix, hostname and ports. Then:

```bash
./scripts/deploy.sh            # test, build, publish a release to ~/.local/share/tandem/current
./scripts/install-service.sh   # once: launchd job <label>.server (127.0.0.1 only, restarts on crash and at login)
./scripts/setup-tunnel.sh      # once: Cloudflare tunnel + DNS for TANDEM_HOSTNAME + launchd job <label>.tunnel
```

- **Updates:** after setup, `deploy.sh` alone ships updates and restarts the server job.
- **Roll back:** point `current` at `previous`, then run `launchctl kickstart -k gui/$(id -u)/<label>.server`.
- **Logs:** `~/Library/Logs/Tandem/`.

### Sign-in when it's public

- **People** sign in with Google through [Neon Auth](https://neon.com/docs/auth/overview) when `TANDEM_NEON_AUTH_URL` is set. Add your public URL as a trusted domain in Neon.
  - Only emails you allow get in: run `tandem member add you@example.com --role owner`, or use the People list under Connect agent.
  - Set `TANDEM_ALLOWED_EMAILS` to make that a hard limit nobody can widen, not even with the owner key.
  - With Google on, signing in to the editor with a key only works on the host itself (the Mac app), never through the tunnel (`TANDEM_TOKEN_LOGIN=on|local|off`).
  - Turn off Neon's email/password sign-in so Google is the only way in: `npx neonctl neon-auth config email-password update --enabled false --disable-sign-up true`.
  - Without Neon, people sign in with an access key.
- **Security model:**
  - The server only listens on loopback, so cloudflared is the only way in.
  - MCP and the API need a bearer key. Editor sign-in is rate-limited, uses an HttpOnly cookie and checks a CSRF header.
  - Signed share links expose only one PNG.
  - For an extra layer, put the editor behind Cloudflare Access and bypass `/mcp`, `/r/` and `/healthz`, so agents and share links keep working.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test                       # builds, then end-to-end tests over real MCP clients
node dist/server.js serve --port 3291 --data /tmp/tandem-dev
./scripts/build-app.sh          # build/Draft.app (universal; bundles both resvg binaries)
```

Layout:
- `src/shared`: model, layout engine, text metrics and SVG renderer, shared by server and browser.
- `src/server`: store, ops, auth, MCP tools, HTTP.
- `src/web`: editor and homepage.
- `mac/`: Swift wrapper.
- `scripts/`: build, install, deploy.

[AGENTS.md](AGENTS.md) is the guide for coding agents and contributors. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to send changes, and [SECURITY.md](SECURITY.md) how to report a vulnerability.

Known limits:
- Text measurement uses Helvetica metrics, so other fonts may wrap slightly differently.
- Server screenshots use the fonts on the host, plus any `.ttf/.otf` dropped into `<data>/fonts`.

## Licence

[MIT](LICENSE).
