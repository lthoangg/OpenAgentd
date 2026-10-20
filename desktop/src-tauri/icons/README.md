# Icons

Generated; never edit them by hand. The sources are the logo's platform
masters in `documents/assets/brand/icons/`, rendered from the Seal by
`scripts/brand/brand.ts`:

- `icon.icns`, `icon.png` (512), `32x32.png`, `64x64.png`, `128x128.png`,
  `128x128@2x.png`: from `openagentd-icon-macos.png` (a Paper tile on Apple's
  grid). Used by macOS and Linux.
- `icon.ico`, `Square*Logo.png`, `StoreLogo.png`: from
  `openagentd-icon-windows.png` (a full-bleed Paper tile).
- `tray-icon.png`: a copy of `openagentd-tray-template.png`, the 64×64
  macOS menu bar template (the open A and the dot; only alpha counts).
- `.brand-masters.json`: the masters' md5s at the last run, so the script
  only regenerates when a master changes.

```sh
python3 scripts/generate_icons.py          # when a master changed or an output is missing
python3 scripts/generate_icons.py --force  # always
```

Release runners consume the committed files directly.
