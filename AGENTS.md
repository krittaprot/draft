# AGENTS.md: working on Draft

Market the product as **Draft — a drawboard for your agent, via MCP or CLI**.
Repository: https://github.com/krittaprot/draft. Live: https://draft.krittaprot.com;
MCP: `/mcp`. Public configuration uses `DRAFT_*`; the CLI is `draft`.
Existing installations retain compatibility aliases and storage paths so upgrades
preserve their data. The Mac build is `build/Draft.app`.

Read by Codex, opencode and other coding agents. Start here, then read `README.md` for the
user-facing story. If `deploy/OPERATOR.md` exists, read it too: it describes the live
deployment on this machine and is not committed.

## What this is

Tandem is an open-source design canvas, MIT licensed. People and AI agents design on it together.
- **Agents** connect over MCP at `/mcp`, using a bearer token or OAuth 2.1.
- **People** use the browser editor, which is also an installable PWA, or the Swift Mac app wrapper.

It is a clean-room take on the Figma mental model: frames, auto-layout, layers. It contains no Figma code; keep it that way and don't decompile Figma.

## Layout

| Path | What it holds |
| --- | --- |
| `src/shared/` | Code that runs on both server and browser. `model.ts` holds the types, `NODE_TYPES` and the `MODEL_GUIDE` text agents read. `layout.ts` is the auto-layout engine. `text.ts` holds Helvetica metrics and wrapping. `render.ts` turns a page into SVG. |
| `src/shared/schema.ts` | The zod prop schema. **Server only**: importing it from `src/web` pulls zod into the browser bundle (about 500 KB). Use `import type`. |
| `src/server/store.ts` | File storage per document: gzipped snapshots for each revision, `history.jsonl`, `comments.json`. Deleting a document moves it to `trash/`. |
| `src/server/ops.ts` | `applyOps`: create, update, delete, move, duplicate, page operations, rename. All edits go through here. |
| `src/server/engine.ts` | Rendering (resvg PNG with a curated system-font list), share links, outline, HTML export, image fetch with an SSRF guard. |
| `src/server/mcp.ts` | The MCP tools (`design_guide`, `create_nodes`, `screenshot` and the rest). Stateless streamable HTTP. |
| `src/server/http.ts` | Every HTTP route: `/api/*`, SSE `/api/events`, sign-in, OAuth, static files, signed `/r/…png` links. |
| `src/server/auth.ts` | Tokens (only hashes are stored), members, sessions, the email allowlist. `auth.json` is reloaded when its mtime changes. |
| `src/server/oauth.ts` | OAuth 2.1 for MCP clients (discovery, dynamic registration, PKCE, rotating refresh). |
| `src/server/neon.ts` | Google sign-in through Neon Auth (Better Auth), handled server-side. |
| `src/server/main.ts` | CLI: `serve`, `token`, `member`, `connect`, `stdio`, `info`. |
| `src/web/app.ts` | The whole editor and home screen in one file: state `S`, `render()`, panels, pointer handling, keyboard, SSE. |
| `src/web/*.html`, `*.css` | `index.html` (app), `landing.html` + `landing.css` + `tokens.css` (public homepage), `sw.js`, `pwa.js`, `manifest.webmanifest`, `offline.html`. |
| `scripts/build.mjs` | esbuild bundles plus asset versioning (see Gotchas). |
| `scripts/deploy.sh`, `install-service.sh`, `setup-tunnel.sh` | Release to `~/.local/share/tandem`, launchd jobs, Cloudflare tunnel. Settings come from `deploy/deploy.env`. |
| `mac/` | Swift wrapper. `scripts/build-app.sh` builds `build/Tandem.app`. |
| `test/` | `node --test` end-to-end tests over real MCP clients, plus OAuth tests. |

## Commands

```bash
pnpm install
pnpm typecheck                 # tsc --noEmit, must stay clean
pnpm test                      # builds, then runs all tests (14 at last count, all passing)
node dist/server.js serve --port 3299 --data <scratch dir> --public-url http://127.0.0.1:3299
```

## Rules for this repo

- **Don't leave servers running.** Never start a long-running dev server for the owner or add one to a startup script.
  - For a manual test, start a throwaway server on a spare port (not 3290) with a scratch data dir.
  - Note its PID, and when you're done, stop it with plain `kill` and check that it exited.
  - Never point a test server at the live data dir.
- **Ship with `./scripts/deploy.sh`.** It tests, builds, publishes a release, restarts the launchd job and health-checks. Don't edit files under `~/.local/share/tandem/current` by hand.
- **Commit style:** a short imperative subject, plus a body listing user-visible changes.
- **Secrets:**
  - Never log, print or commit tokens.
  - `deploy/deploy.env` is git-ignored, and so is `deploy/OPERATOR.md`.
  - Owner tokens live in `<data>/owner-token`.
- **Sign-in is locked down on purpose.** Keep these restrictions unless the owner asks to change them:
  - `TANDEM_ALLOWED_EMAILS` is a hard allowlist.
  - Token sign-in to the editor works only on the host itself, never through the tunnel (`TANDEM_TOKEN_LOGIN`).
- **Code style:**
  - Match the surrounding code: compact TypeScript, few comments, and each comment explains *why*.
  - In the editor, update state in `S`, then call `render()`.
- **Brand colours (editor):**
  - They come from the icon (navy tile, blue-to-amber trail, gold sparks, white cursor).
  - Blue `#1F5FD6` means *you*: selection, handles and primary buttons.
  - Amber `#E8801A` means *agents*: change outlines, toasts and agent names.
  - Gold `#FFC23D` with ink `#3A2600` marks comment pins and the unread badge.
  - Navy `#0D1838` is the brand surface: sign-in pages and the PWA splash screen.
  - Icons: `node scripts/icon-from-art.mjs <artwork.png>` cuts the tile out of flat artwork into `mac/icon-source.png`; then `node scripts/make-icons.mjs` builds the web icons.
  - The homepage uses the OKLCH tokens in `tokens.css`. Every colour and font there goes through a token.

## Gotchas you will hit

1. **Asset versioning.** `build.mjs` rewrites references to `app.js`, `style.css`, `pwa.js`, `tokens.css` and `landing.css` as `?v=<hash>`. The server serves those as immutable and sends unversioned ones with `no-cache` plus `CDN-Cache-Control: no-store`.
   - This exists because Cloudflare's zone browser-cache TTL rewrote `no-cache` to 4 hours, so an old `app.js` ran against a new `index.html` and crashed.
   - If you add a new script or stylesheet, add it to the list in `build.mjs`.
2. **Shared code must stay browser-safe.** `src/shared` can't import node modules or zod.
3. **Text metrics are Helvetica.** Wrapping is approximate for other fonts. Thai and CJK use wider estimates.
4. **Undo is revision-based.** Cmd+Z restores the revision before your own last change. `undoChain` in `app.ts` makes repeated presses step further back. There is no redo.
5. **The canvas is re-rendered on every change** (`world.innerHTML`), so event targets go stale. Hit-test with `document.elementFromPoint` when an event spans two clicks, like dblclick.
6. **The drawing tool is captured at pointerdown** (`S.drag.tool`), because the previous shape's save can finish mid-drag.
7. **Home and editor routing is hash-based.** `#doc=<id>[&node=<id>]` opens a design; anything else shows Home. Live SSE refreshes of Home must check `onHome()` so they don't cover the editor.
8. **Read-only UI.** `body.readonly` is set for viewers and during revision preview, `body.viewer` for viewers. Mark edit-only inspector buttons `edit-only` and comment buttons `comment-only`.

## Testing sign-in

`test/oauth.test.mjs` checks the live Google sign-in round trip only when `TANDEM_TEST_NEON_AUTH_URL` and `TANDEM_TEST_PUBLIC_URL` are set. Without them it uses an address that never answers and checks everything else.
- `deploy.sh` sets both from `deploy/deploy.env`.
- CI and contributors run without them.
- Agent shells are often sandboxed away from the internet, and then the live check reports "unreachable". Use a real terminal to check it.

## Testing the editor

There are no automated browser tests yet; `test/` covers the server, MCP and OAuth. To check UI changes by hand:
1. Run a throwaway server on scratch data.
2. Sign in at `http://127.0.0.1:<port>/auth?token=<that data dir's owner-token>` (local only).
3. Drive it with a browser tool.

To test against real content, seed demo data with `node scripts/demo-seed.mjs <base-url> <data-dir>`. Check:
- 1440 px, 768 px and 375 px widths.
- Light and dark mode.
- A viewer token (`node dist/server.js token create x --role viewer --data <dir>`).

## Status (2026-10-15)

Done and live:
- **MCP tools and the editor:** all MCP tools, the web editor with Home screen, comments, and history with preview and restore.
- **Sharing and sign-in:** share links, OAuth for connector apps, Google sign-in locked to the allowlist.
- **Site:** the public homepage and the installable PWA.
- **Editor QA pass:** every control was clicked through, and the bugs it found were fixed in commit `203e0b3`.

Open items, roughly by value:
1. **Automated browser tests** (Playwright) for the editor flows listed under "Testing the editor". Today those checks are manual.
2. **Test PWA install on real Safari** (macOS: File → Add to Dock) and on an iPhone (Share → Add to Home Screen).
3. **Missing editor features:**
   - Marquee (drag-box) selection.
   - Double-click a frame to select inside it.
   - Redo.
   - Copy and paste.
   - Align and distribute.
   - On screens narrower than 900 px the side panels are hidden, so editing there is view-mostly.
4. **Mac app** (`scripts/install.sh`) hasn't been rebuilt or reinstalled since the PWA and Home changes.
5. **Fonts:** the editor uses Helvetica metrics; server screenshots use host fonts plus `<data>/fonts`. Using the same metrics in both would make text wrap identically.
