# account-pages

Static files for `https://account.openagentd.dev`, which the connector gallery and connector sign-in use. None of them hold secrets. Publish them with the rest of the account site.

| Path on the site | File | Used by |
|---|---|---|
| `/oauth/callback` | [`oauth/callback.html`](oauth/callback.html) | The return address (`redirect_uri`) a connector sign-in uses when the browser isn't on the server's machine. It asks the user to confirm, then passes the code on to the OpenAgentd that started the sign-in: its `oauth-done.html` page, or the `openagentd://mcp-oauth` app link. Otherwise it shows the address to copy. |
| `/connectors/v1.json` | [`connectors/v1.json`](connectors/v1.json) | The connector gallery every install reads (`appv3/crates/api/src/gallery.rs`) |
| `/connectors/v1.json.sig` | written by `scripts/gallery.py sign` | Ed25519 signature over the exact bytes of `v1.json`, base64. A list without a valid signature is ignored. |

## Adding a connector

1. Add an entry to `connectors/v1.json`. The entry types are below.
2. `python3 scripts/gallery.py check`: validates every entry and test-connects each address. `none` must answer `initialize`, and `oauth` must ask for sign-in and offer automatic client registration.
3. `python3 scripts/gallery.py sign --key ~/.config/openagentd/gallery-signing-key.pem` writes `connectors/v1.json.sig`.
4. Publish `v1.json` and `v1.json.sig` together. Installs pick the new list up the next time the gallery opens, with no app update.
5. At release time, `python3 scripts/gallery.py bundle` copies the list into the app (`appv3/crates/api/data/gallery.json`) as its offline copy.

The signing key's public half is `DEFAULT_PUBLIC_KEY` in `appv3/crates/api/src/gallery.rs`. Keep the private key out of the repository.

## Entry types

```json
{"type": "connector", "id": "notion", "name": "Notion", "category": "work",
 "description": "Search, read and write pages and databases.",
 "url": "https://mcp.notion.com/mcp", "auth": "oauth",
 "previous_urls": ["https://mcp.notion.com/sse"], "min_app": "3.60.0"}
```

- `auth`: `"none"` (works without an account), `"oauth"` (signs in at the service), or a key: `{"header": "Authorization", "template": "Bearer {key}", "key_url": "https://…", "key_label": "Personal access token"}`.
- `url` must be `https`. An entry never runs a program.
- `previous_urls`: addresses the connector used before. Installs still on one are offered "Update".
- `min_app`: older apps hide the entry. Apps also hide entry types and auth kinds they don't know.
- `icon` (optional): the service's logo as one SVG path, `{"path": "M…", "view_box": "0 0 24 24"}`. The app draws it in the text colour, so it follows light and dark mode. Only path commands and numbers are allowed, at most 4096 characters; a bad icon is dropped and the entry keeps its monogram. The current logos come from [Simple Icons](https://simpleicons.org) (CC0) and only name the service a connector reaches.
- `{"type": "plugin", …}` entries are reserved for plugin bundles (`source`, `rev`, `sha256`). Current apps parse and hide them.
