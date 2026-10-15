# Tandem

An open-source design canvas that AI agents (Claude Code, Codex, opencode, or any MCP client) drive over MCP. People edit, comment and review in a live editor. Clean-room design; no Figma code. MIT.

- **Agents**: 19 MCP tools at `/mcp`: create/update/move/duplicate nodes (Figma-style frames, auto-layout, text, images, SVG), `screenshot` (PNG plus a login-free share link), HTML/SVG export, comments, history, restore.
- **People**: an infinite canvas with layers, inspector, drawing tools, comments, and revision history with change highlights. Agent edits appear live.
- **Mac app**: `scripts/build-app.sh` builds `build/Tandem.app` (needs Node 20+). It uses a running server, or starts its bundled one.

```bash
pnpm install && pnpm test          # build + end-to-end tests
./scripts/build-app.sh             # build/Tandem.app
node dist/server.js serve          # http://127.0.0.1:3290, data in ~/.local/share/tandem/data
node dist/server.js connect claude # or codex / opencode
```

Not done yet: launchd + Cloudflare tunnel deploy scripts and an install script.
