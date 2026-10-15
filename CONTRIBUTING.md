# Contributing to Draft

Thanks for helping. Draft is a small project, so the process is light.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Read [AGENTS.md](AGENTS.md). It's written for coding agents but works just as well for people: the layout, the commands, the rules and the traps.

## Making a change

```bash
pnpm install
pnpm typecheck
pnpm test
```

- **Keep it working everywhere:** both commands must pass. CI runs them on Linux and macOS.
- **Check UI changes in a browser:**
  - Run a throwaway server on scratch data: `node dist/server.js serve --port 3299 --data /tmp/tandem-dev`.
  - Look at 1440, 768 and 375 px widths, in light and dark mode, and as a view-only user.
  - Stop the server when you're done.
- **Match the code around you:** compact TypeScript, few comments, and each comment says *why*.
- **Clean room:** never add Figma code, assets or anything decompiled from it.
- **Commit messages:** a short imperative subject, plus a body listing the changes people will notice.

## Ideas that would help

Automated browser tests (Playwright) for the editor; marquee selection, redo, copy and paste, align and distribute; and making text wrap identically in the editor and in server screenshots. [AGENTS.md](AGENTS.md#status-2026-10-15) has the current list.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
