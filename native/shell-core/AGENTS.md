# Shared Native Shell Crate Guide

`openagentd-shell-core` holds the Tauri-free logic that both the desktop and
mobile shells need identically: backend-server config persistence, base-URL
normalization, access keys in the OS credential store, and bounded workspace
downloads. Before it existed the two shells carried byte-for-byte copies that
drifted (a trimmed-vs-untrimmed access key once authenticated on desktop and
failed on mobile).

## Where to look

- `src/backend_config.rs`: `AppBackendConfig`/`SavedAppServer`, the JSON file
  format (including legacy-shape migration and the empty-list default),
  `normalize_base_url`, and the load/save/remove-by-path functions.
- `src/access_key.rs`: keyring entries keyed by canonical `http(s)` origin.
- `src/download.rs`: the 100 MB ceiling, base64/`data:`/remote resolution, and
  collision-safe cache filenames.

## Boundaries

- No `tauri` dependency, ever. Functions take `&Path` and `&reqwest::Client`;
  the shells own `AppHandle` → path resolution, `#[tauri::command]` wrappers,
  and their differently tuned shared HTTP clients.
- TLS backend and certificate roots are chosen by each shell's own `reqwest`
  dependency (Cargo unifies features); this crate asks only for `json`.
- Behaviour changes here reach both apps. Add or update the unit test first,
  then re-run both shell checks.
- The crate is internal (`publish = false`, version `0.0.0`) and is not part
  of the release version sync.

## Checks

From the repository root:

```bash
make verify-shell-core   # fmt --check, clippy -D warnings, cargo test
make verify-native       # also runs the desktop and mobile crates
```
