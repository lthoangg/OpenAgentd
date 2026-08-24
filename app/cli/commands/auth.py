"""``openagentd auth`` — central OAuth dispatcher for provider authentication.

Each provider that needs OAuth implements its own ``oauth.py`` module with
a ``login()`` function.  This module dispatches to the correct one.

Usage (via CLI):
    openagentd auth copilot            # GitHub Copilot login
    openagentd auth codex              # OpenAI Codex login (browser PKCE)
    openagentd auth codex --device     # OpenAI Codex login (headless device code)
    openagentd auth --list             # show available providers

Usage (direct):
    uv run python -m app.cli.commands.auth codex

Adding a new provider:
    1. Create ``app/agent/providers/<name>/oauth.py`` with a ``login()`` function.
    2. Add an entry to ``_PROVIDERS`` below.
"""

from __future__ import annotations

import argparse
import sys

# -- Provider registry --------------------------------------------------------
# Each entry: provider_name -> (module_path, description)

_PROVIDERS: dict[str, tuple[str, str]] = {
    "copilot": (
        "app.agent.providers.copilot.oauth",
        "GitHub Copilot — device-flow OAuth",
    ),
    "codex": (
        "app.agent.providers.codex.oauth",
        "OpenAI Codex — PKCE OAuth (ChatGPT subscription)",
    ),
    "grok": (
        "app.agent.providers.grok.oauth",
        "Grok Build — device-flow OAuth (Grok subscription)",
    ),
}


def _list_providers() -> None:
    print("Available OAuth providers:\n")
    for name, (_, desc) in sorted(_PROVIDERS.items()):
        print(f"  {name:15s}  {desc}")
    print(f"\nUsage: openagentd auth <{'|'.join(_PROVIDERS)}>")


def _run_login(provider: str, **kwargs: bool) -> None:
    entry = _PROVIDERS.get(provider)
    if not entry:
        print(f"Unknown provider: '{provider}'")
        _list_providers()
        sys.exit(1)

    module_path, _ = entry
    import importlib
    import inspect

    mod = importlib.import_module(module_path)
    # Pass only kwargs that the login() function accepts
    sig = inspect.signature(mod.login)
    accepted = {k: v for k, v in kwargs.items() if k in sig.parameters}
    mod.login(**accepted)


def cmd_auth(args: argparse.Namespace) -> None:
    """Authenticate with an OAuth-based LLM provider."""
    if args.list_providers or not args.provider:
        _list_providers()
        return
    _run_login(args.provider, device=args.device)


# -- Standalone CLI entrypoint (``python -m app.cli.commands.auth``) ---------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OAuth login for LLM providers",
        usage="openagentd auth <provider> [--device]",
    )
    parser.add_argument(
        "provider",
        nargs="?",
        help=f"Provider to login ({', '.join(_PROVIDERS)})",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        dest="list_providers",
        help="List available providers",
    )
    parser.add_argument(
        "--device",
        action="store_true",
        help="Use headless device-code flow instead of browser (codex only)",
    )
    args = parser.parse_args()

    if args.list_providers or not args.provider:
        _list_providers()
        return

    _run_login(args.provider, device=args.device)


if __name__ == "__main__":
    main()
