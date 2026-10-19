# OpenAgentd Brand Assets

Source-faithful brand assets based on `octobot-agentd-source.png`. Layout, colour and type
for anything composed here follow `DESIGN.md` ("OpenAgentd Paper").

## Files

- `octobot-agentd-source.png` - mascot source of truth
- `openagentd-app-icon.png` - transparent mascot icon for app chrome / avatar tile
- `openagentd-banner-light.webp`, `openagentd-banner-dark.webp` - README banner (1600x640 at 2x)
- `openagentd-social-preview.png` - GitHub social preview, 1280x640; upload it in the
  repository's Settings → General → Social preview
- `banner/banner.html` - source for the banner and social preview; `banner/banner-shot-*.webp`
  are the app captures it embeds

Regenerate the banner after changing `banner/banner.html` or the app UI:

```bash
scripts/readme-shots/run.sh up && scripts/readme-shots/run.sh stage
scripts/readme-shots/run.sh capture banner-shot   # or no scene name for every README shot
bun scripts/readme-shots/banner.mjs
```

App-imported copies live in `../../../web/src/assets/brand/`. The browser-public copy in `../../../web/public/brand-assets/` is only for direct URL needs such as the favicon.

## Palette

Mascot colours (UI colours are in `DESIGN.md`):

- Agent Gold: `#FCC352`
- Loop Orange: `#FA8030`
- Kernel Brown: `#5F2511`
- Shell White: `#FBF8F7`
