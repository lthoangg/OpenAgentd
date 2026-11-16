# Design: brand mark

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Brand mark

The OpenAgentd logo is built by
`scripts/brand/brand.ts` from Schibsted Grotesk 600 and drawn inline by
`components/brand/Logo.tsx` from the generated `lib/brand/logo-data.ts`.
Never redraw it by hand; change the generator. openagentd.dev copies it from
this repository. Files and regeneration: `documents/assets/brand/README.md`.

- **The Seal**: an ink disc with an open A (no crossbar) cut out of it, and a
  Signal Blue dot as the crossbar. The dot is the agent. On a 64-unit grid:
  disc radius 27, A from y 20 to 47, 11.5 wide each side, stroke 6, dot radius
  3.75 at y 39. Used wherever the app shows its mark: the boot and loading
  screens, the crash screen, the empty session, and Settings → About.
- **The wordmark**: "OpenAgentd" with the font's A replaced by the same open A
  and dot. Used in Settings → About and the tray popup.
- **Color**: the ink is `currentColor`, set to `--color-text`; the dot is
  `--logo-signal`, which is `--accent-blue`. Both follow the theme. No tile,
  rounding, or shadow around the Seal in the app.
- **Type**: the wordmark is outlines, so the app needs no extra font. The OS's UI
  font and JetBrains Mono stay the only UI faces; Schibsted Grotesk appears only inside
  the wordmark (and in marketing headlines outside the app).
- **Motion**: the 3.3s Seal-to-wordmark intro is for the website and media,
  never the app. In the app only the dot moves: on loading screens it pulses
  (`oa-seal-pulse`, opacity only, `glacial` 800ms alternating). With reduced
  motion it stays still. Everywhere else the Seal is static.
- **Platform icons** (masters in `documents/assets/brand/icons/`, built by
  `scripts/generate_icons.py`): the ink Seal on a Paper tile. macOS uses an
  824px tile on Apple's 1024 grid with a hairline border; Windows a
  full-bleed tile so 16–32px sizes stay legible; iOS a full-bleed opaque Paper
  square without an alpha channel; Android an adaptive foreground whose disc
  sits inside the 66dp safe zone on a `#FAF6EC` background. The macOS menu bar
  icon is a monochrome template of the open A and the dot without the disc,
  which is too heavy at 18pt.
