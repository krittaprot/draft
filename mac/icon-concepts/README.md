# Minimal icon concepts

Generated with Codex's built-in image generation through ChatGPT on 2026-10-15.

- `minimal-a.png`: white pointer, cyan gesture, amber dot.
- `minimal-b.png`: white pointer and cyan curve; selected for the app.

Direction: flat navy rounded tile, strong white pointer, minimal cyan gesture,
generous negative space, readable at Dock sizes; no glass, bevel, rim or reflections.

Regenerate platform assets from the project root:

```sh
node scripts/icon-from-art.mjs mac/icon-concepts/minimal-b.png
node scripts/make-icons.mjs
./scripts/build-app.sh
./scripts/deploy.sh
```

The extraction script removes the white background and normalizes the tile to a
square on a transparent 1024px canvas. macOS, iOS and Android assets use their
respective padding rules.
