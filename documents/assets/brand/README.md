# OpenAgentd Brand Assets

The source of truth for the OpenAgentd logo. Layout, colour and type for
anything composed here follow `DESIGN.md` ("OpenAgentd Paper", "Brand mark").
openagentd.dev copies the logo from this repository (its `bun run
sync-assets`); never redraw it by hand anywhere.

## The logo

- **The Seal**: an ink disc with an open A (no crossbar) cut out of it, and a
  Signal Blue dot as the crossbar. The dot is the agent. On a 64-unit grid:
  disc radius 27, A from y 20 to 47, 11.5 wide each side, stroke 6, dot
  radius 3.75 at y 39.
- **The wordmark**: "OpenAgentd" in Schibsted Grotesk 600 with its A replaced
  by the same open A and dot.
- **Colours**: ink is the Paper text colour (`#1A1714` light, `#F5EBD8` dark);
  the dot is Signal Blue (`#5AA8E2` light, `#7CC2F0` dark).
- **The intro** (3.3s): the Seal stamps down, the dot lands, the Seal opens
  like an iris, the A shrinks into the word, the name unfolds outward, and the
  dot blinks.

All of it is built by `scripts/brand/brand.ts` from the font in
`scripts/brand/fonts/` (OFL). The markup and the intro's CSS live in
`web/src/lib/brand/` (`logo-svg.ts`, `logo.css`, and the generated
`logo-data.ts`).

## Files

- `logo/`: `openagentd-{seal,wordmark,intro}-{light,dark}.svg`,
  `openagentd-seal-{light,dark}-{512,1024}.png`, and the intro as
  `openagentd-intro-{light,dark}.{mp4,gif}`. Standalone files with fixed
  light or dark Paper colours, for READMEs, slides and the website.
- `web/`: `favicon.svg` (follows the colour scheme), `favicon.png` (64),
  `favicon-192.png`, `apple-touch-icon.png` (180, the Seal on Paper).
- `icons/`: the platform icon masters that `scripts/generate_icons.py` turns
  into native icons: `openagentd-icon-macos.png` (Paper tile on Apple's grid),
  `openagentd-icon-windows.png` (full-bleed tile), the Android adaptive
  foreground, the macOS menu bar template (the open A and the dot), and
  `mobile-icons.json` (the `cargo tauri icon` manifest for iOS and Android).
- `openagentd-app-icon.png`: the opaque 1024 px app icon (iOS, SideStore,
  Android legacy icons). Its path is a published URL; keep it.
- `openagentd-banner-light.webp`, `openagentd-banner-dark.webp`: README banner
  (1600x640 at 2x).
- `openagentd-social-preview.png`: GitHub social preview, 1280x640; upload it
  in the repository's Settings → General → Social preview.
- `banner/banner.html`: source for the banner and social preview;
  `banner/banner-shot-*.webp` are the app captures it embeds.

## Regenerate

After changing the logo geometry or `logo.css`:

```bash
bun install --cwd scripts/brand && bun scripts/brand/brand.ts
python3 scripts/generate_icons.py --force
bun scripts/readme-shots/banner.mjs
```

After changing `banner/banner.html` or the app UI:

```bash
scripts/readme-shots/run.sh up && scripts/readme-shots/run.sh stage
scripts/readme-shots/run.sh capture banner-shot   # or no scene name for every README shot
bun scripts/readme-shots/banner.mjs
```

The app draws the logo inline (`web/src/components/brand/Logo.tsx`); its
favicons in `web/public/` are copies written by `brand.ts`.
