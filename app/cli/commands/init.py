"""``openagentd init`` — interactive first-time setup.

Asks the user for a provider + model + credentials, then writes ``.env``
to the XDG config directory.  When the file already exists, new credentials
are merged in-place so user customisations (extra keys, base-URL overrides,
etc.) are preserved.
"""

from __future__ import annotations

import argparse

from app.cli.paths import _config_dir
from app.cli.seed import SeedDownloadError, install_seed
from app.cli.ui import _ask, _bold, _cyan, _dim, _green, _menu, _red, _yellow

#: Provider → env-var name
_PROVIDER_KEY_VAR: dict[str, str] = {
    "googlegenai": "GOOGLE_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "zai": "ZAI_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "router9": "ROUTER9_API_KEY",
    "cliproxy": "CLIPROXY_API_KEY",
    "ollama": "OLLAMA_API_KEY",
}

#: Provider → curated model list (last entry = "custom" sentinel added at runtime)
_PROVIDER_MODELS: dict[str, list[str]] = {
    "googlegenai": [
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
    ],
    "openai": [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.4-pro",
        "gpt-5",
        "gpt-5-mini",
        "gpt-4.1",
    ],
    "openrouter": [
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5.4",
        "google/gemini-3-flash-preview",
        "x-ai/grok-4",
        "qwen/qwen3-coder-plus",
        "deepseek/deepseek-v4",
        "meta-llama/llama-4-maverick:free",
    ],
    "zai": [
        "glm-5",
        "glm-5.1",
        "glm-5-turbo",
        "glm-5v-turbo",
        "glm-4.7",
        "glm-4.6v",
    ],
    "nvidia": [
        "deepseek-ai/deepseek-v3.1",
        "meta/llama-4-maverick-17b-128e-instruct",
        "qwen/qwen3-coder-480b-a35b-instruct",
        "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    ],
    "copilot": [
        "gpt-5.4",
        "gpt-5.4-mini",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4.5",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "grok-code-fast-1",
    ],
    "codex": [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.2",
        "gpt-5.1-codex",
    ],
    "vertexai": [
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-2.5-pro",
    ],
    "xai": [
        "grok-4",
        "grok-4-fast",
        "grok-code-fast-1",
    ],
    "grok": [
        "grok-4.5",
    ],
    "deepseek": [
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "deepseek-r1",
    ],
    "router9": [
        # Subscription / OAuth
        "cc/claude-sonnet-4-5-20250929",
        "cc/claude-opus-4-6",
        "cc/claude-haiku-4-5-20251001",
        "cx/gpt-5.2-codex",
        "cx/gpt-5.1-codex-max",
        "gh/gpt-5",
        "gh/claude-4.5-sonnet",
        "gh/gemini-3-pro",
        # Free tier
        "gc/gemini-3-flash-preview",
        "gc/gemini-2.5-pro",
        "if/kimi-k2-thinking",
        "if/qwen3-coder-plus",
        "if/deepseek-r1",
        "qw/qwen3-coder-plus",
        "kr/claude-sonnet-4.5",
        # Cheap paid
        "glm/glm-4.7",
        "minimax/MiniMax-M2.1",
        "kimi/kimi-latest",
    ],
    "cliproxy": [
        # Gemini CLI (OAuth)
        "gemini-3-flash-preview",
        "gemini-3.1-pro-preview",
        "gemini-2.5-pro",
        # ChatGPT Codex (OAuth)
        "gpt-5.2-codex",
        "gpt-5.4",
        "gpt-5",
        # Claude Code (OAuth)
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-6",
        "claude-haiku-4-5-20251001",
    ],
    "ollama": [
        # Locally pulled models (run `ollama pull <model>` first)
        "llama3.2",
        "llama3.2:1b",
        "qwen2.5-coder",
        "qwen2.5-coder:7b",
        "deepseek-r1",
        "gemma3",
        "mistral",
        "llava",
        # Cloud models — routed via local daemon after `ollama signin`
        "kimi-k2.6-cloud",
        "deepseek-v4-pro-cloud",
        "deepseek-v4-flash-cloud",
        "glm-5.1-cloud",
        "qwen3.5-cloud",
        "gpt-oss:120b-cloud",
    ],
}


def cmd_init(_args: argparse.Namespace) -> None:  # noqa: C901
    """Interactive first-time setup: write .env and seed config files.

    ``_args`` is accepted but unused — the parser may pass an empty
    ``Namespace`` (when called from ``ensure_initialised``) or a parsed
    one (from the ``init`` subcommand). Either is fine.
    """
    import getpass

    config_dir = _config_dir()
    env_file = config_dir / ".env"

    print()
    print(f"  {_bold(_cyan('OpenAgentd init'))}")
    print(f"  {_dim('Config:')} {env_file}")
    print()

    # ── 1. Provider ──────────────────────────────────────────────────────────
    providers = list(_PROVIDER_MODELS.keys())
    provider_labels = [
        "googlegenai  — Google AI Studio (free tier available)",
        "openai       — OpenAI (GPT-5.x, GPT-4.1, etc.)",
        "openrouter   — OpenRouter (many models, free tiers)",
        "zai          — Z.AI / GLM",
        "nvidia       — NVIDIA NIM",
        "copilot      — GitHub Copilot (OAuth, no API key needed)",
        "codex        — OpenAI Codex via ChatGPT subscription (OAuth)",
        "vertexai     — Vertex AI (needs GCP project + gcloud auth)",
        "xai          — xAI Grok (grok-4, grok-code-fast-1)",
        "grok         — Grok Build via Grok subscription (OAuth)",
        "deepseek     — DeepSeek (deepseek-v4, deepseek-r1)",
        "router9      — 9Router local proxy (40+ providers, OpenAI-compatible)",
        "cliproxy     — CLIProxyAPI local proxy (multiple CLI-backed models)",
        "ollama       — Ollama local daemon (no API key; cloud via -cloud suffix)",
    ]
    idx = _menu("Choose your LLM provider:", provider_labels)
    provider = providers[idx]
    print(f"  {_green('✓')}  Provider: {provider}")

    # ── 2. Model ─────────────────────────────────────────────────────────────
    model_list = _PROVIDER_MODELS[provider] + ["custom — type your own"]
    midx = _menu("Choose a model:", model_list)
    if midx == len(model_list) - 1:
        model = _ask("Model name:")
    else:
        model = model_list[midx]
    full_model = f"{provider}:{model}"
    print(f"  {_green('✓')}  Model: {full_model}")

    # ── 3. API credentials ───────────────────────────────────────────────────
    api_key = ""
    gcp_project = ""
    gcp_location = "global"

    if provider == "copilot":
        print(f"  {_dim('ℹ')}  No API key needed — authenticate via OAuth after setup.")
        print(f"     Run: {_bold('openagentd auth copilot')}")
    elif provider == "codex":
        print(f"  {_dim('ℹ')}  No API key needed — authenticate via OAuth after setup.")
        print(f"     Run: {_bold('openagentd auth codex')}")
    elif provider == "grok":
        print(f"  {_dim('ℹ')}  No API key needed — authenticate via OAuth after setup.")
        print(f"     Run: {_bold('openagentd auth grok')}")
    elif provider == "ollama":
        print(
            f"  {_dim('ℹ')}  Ollama needs no API key — make sure the daemon is running "
            f"({_bold('ollama serve')})."
        )
        print(
            f"     For cloud models (suffix {_bold('-cloud')}), run "
            f"{_bold('ollama signin')} first."
        )
    elif provider == "vertexai":
        gcp_project = _ask("Google Cloud project ID:")
        loc_input = _ask("Cloud location [global]:")
        if loc_input:
            gcp_location = loc_input
        print(
            f"  {_dim('ℹ')}  Ensure you have run: gcloud auth application-default login"
        )
    else:
        key_var = _PROVIDER_KEY_VAR[provider]
        print(
            f"  {_cyan('?')} Paste your {_bold(key_var)} (input hidden): ",
            end="",
            flush=True,
        )
        api_key = getpass.getpass("").strip()
        if not api_key:
            print(
                f"  {_yellow('⚠')}  No key entered — you can add it later to {env_file}"
            )
        else:
            print(f"  {_green('✓')}  API key received")

    # ── 4. Write .env ────────────────────────────────────────────────────────
    config_dir.mkdir(parents=True, exist_ok=True)

    # Build the new credential lines for the chosen provider.
    new_creds: dict[str, str] = {}
    new_comments: dict[str, str] = {}  # key → inline comment line to append
    if provider == "googlegenai":
        new_creds["GOOGLE_API_KEY"] = api_key
    elif provider == "openai":
        new_creds["OPENAI_API_KEY"] = api_key
    elif provider == "openrouter":
        new_creds["OPENROUTER_API_KEY"] = api_key
    elif provider == "zai":
        new_creds["ZAI_API_KEY"] = api_key
    elif provider == "nvidia":
        new_creds["NVIDIA_API_KEY"] = api_key
    elif provider == "xai":
        new_creds["XAI_API_KEY"] = api_key
    elif provider == "deepseek":
        new_creds["DEEPSEEK_API_KEY"] = api_key
    elif provider == "router9":
        new_creds["ROUTER9_API_KEY"] = api_key
        new_comments["ROUTER9_API_KEY"] = "# ROUTER9_BASE_URL=http://localhost:20128/v1"
    elif provider == "cliproxy":
        new_creds["CLIPROXY_API_KEY"] = api_key
        new_comments["CLIPROXY_API_KEY"] = (
            "# CLIPROXY_BASE_URL=http://localhost:8317/v1"
        )
    elif provider == "ollama":
        # Local daemon — defaults (placeholder key + localhost URL) cover it.
        # Nothing to write; users override OLLAMA_BASE_URL manually if needed.
        pass
    elif provider == "vertexai":
        new_creds["GOOGLE_CLOUD_PROJECT"] = gcp_project
        new_creds["GOOGLE_CLOUD_LOCATION"] = gcp_location

    from app.cli.seed import write_env_credentials

    created = write_env_credentials(env_file, new_creds, comments=new_comments)
    if created:
        print(f"  {_green('✓')}  Config written to {env_file}")
    else:
        print(f"  {_green('✓')}  Config updated at {env_file}")

    # ── 5. Install seed agents + config ──────────────────────────────────────
    # Seed install is "fill in the gaps" only — files already on disk are
    # kept untouched. Once the user has a populated config, those files are
    # theirs (think shell rc files, not a managed package). Updates ship by
    # users browsing the repo and copying what they want.
    print()
    print(f"  {_dim('…')}  Installing default agents and config")
    try:
        result = install_seed(config_dir, provider_model=full_model)
    except SeedDownloadError as exc:
        print(f"  {_red('✗')}  Could not install seed bundle: {exc}")
        print(f"     {_dim('Network issue? Retry with')} {_bold('openagentd init')}")
        print(
            f"     {_dim('Or copy manually from')} "
            f"https://github.com/lthoangg/openagentd/tree/main/seed"
        )
    else:
        if result.agents_written or result.skills_written or result.configs_written:
            parts: list[str] = []
            if result.agents_written:
                n = len(result.agents_written)
                parts.append(f"{n} agent{'s' if n != 1 else ''}")
            if result.skills_written:
                n = len(result.skills_written)
                parts.append(f"{n} skill{'s' if n != 1 else ''}")
            if result.configs_written:
                n = len(result.configs_written)
                parts.append(f"{n} config{'s' if n != 1 else ''}")
            print(
                f"  {_green('✓')}  Installed {', '.join(parts)} "
                f"{_dim(f'(source: {result.source})')}"
            )
        else:
            print(f"  {_dim('ℹ')}  Existing agents/config kept untouched")

    # ── Done ─────────────────────────────────────────────────────────────────
    print()
    if provider == "copilot":
        print(f"  {_bold('Next:')} authenticate with GitHub Copilot:")
        print(f"    {_bold('openagentd auth copilot')}")
        print()
    elif provider == "codex":
        print(f"  {_bold('Next:')} authenticate with your ChatGPT subscription:")
        print(f"    {_bold('openagentd auth codex')}")
        print()
    elif provider == "grok":
        print(f"  {_bold('Next:')} authenticate with your Grok subscription:")
        print(f"    {_bold('openagentd auth grok')}")
        print()
    print(f"  {_bold('Start:')}  {_bold('openagentd')}")
    print()
