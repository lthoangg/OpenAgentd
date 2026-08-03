from __future__ import annotations

ZEN_PROVIDER_ID = "opencode"
GO_PROVIDER_ID = "opencode-go"
PROVIDER_IDS = (ZEN_PROVIDER_ID, GO_PROVIDER_ID)

ZEN_LABEL = "OpenCode Zen"
GO_LABEL = "OpenCode Go"
ZEN_DESCRIPTION = "Curated coding models through the OpenCode Zen gateway."
GO_DESCRIPTION = "Open coding models through the OpenCode Go subscription."

ZEN_API_KEY_ENV = "OPENCODE_ZEN_API_KEY"
GO_API_KEY_ENV = "OPENCODE_GO_API_KEY"
API_KEY_ENV_BY_PROVIDER = {
    ZEN_PROVIDER_ID: ZEN_API_KEY_ENV,
    GO_PROVIDER_ID: GO_API_KEY_ENV,
}

ZEN_BASE_URL = "https://opencode.ai/zen/v1"
GO_BASE_URL = "https://opencode.ai/zen/go/v1"
ZEN_DOCS_URL = "https://opencode.ai/docs/zen/"
GO_DOCS_URL = "https://opencode.ai/docs/go/"

PUBLIC_API_KEY = "public"
