# Icons

`icon.png` is `documents/assets/brand/openagentd-app-icon.png`, the opaque
1024 px iOS master rendered from the Seal by `scripts/brand/brand.ts`, saved
as RGBA because `tauri::generate_context!` rejects other modes. Never edit it
by hand. Everything else here is generated and gitignored:

```sh
python3 scripts/generate_icons.py   # from the repository root
cd mobile && make ios-icons         # also copies ios/ into the Xcode AppIcon set
cd mobile && make android-icons     # also copies android/ into the Gradle project
```

The script runs `cargo tauri icon` with
`documents/assets/brand/icons/mobile-icons.json`: iOS icons come from the
opaque master (saved without an alpha channel), and the Android adaptive icon
uses `openagentd-icon-android-foreground.png` on a `#FAF6EC` background.
