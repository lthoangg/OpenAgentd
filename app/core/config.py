from pathlib import Path

from pydantic import model_validator
from pydantic.fields import Field
from pydantic.types import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_dirs(app_env: str) -> dict[str, Path]:
    """Return the default XDG-aligned roots for the given environment.

    Five separate roots:

    - ``data``      — openagentd-internal data (SQLite DB).  Denied to agent fs tools.
    - ``config``    — hand-edited configuration (agents, skills, prompts, ``.env``,
      OAuth tokens).  Allowed.
    - ``state``     — logs, telemetry, OTEL rollups.  Denied.
    - ``cache``     — regeneratable throwaway (quote of the day, OAuth tokens).
      Denied.
    - ``wiki``      — shared wiki store (``USER.md``, ``topics/``, ``notes/``).
      Allowed.
    - ``workspace`` — per-session agent workspaces (``{workspace}/<sid>``).
      The active session's workspace is the relative-path root for fs tools.
      User uploads land inside the workspace at ``{workspace}/<sid>/uploads/``
      so agent tools can reach them as ``uploads/<filename>`` without a
      staging step.

    Production (``app_env=production``) maps to OS XDG conventions::

        ~/.local/share/openagentd            ← data (DB)
        ~/.local/share/openagentd-wiki       ← wiki
        ~/.local/share/openagentd-workspace  ← workspace (incl. uploads/)
        ~/.config/openagentd                 ← config
        ~/.local/state/openagentd            ← state
        ~/.cache/openagentd                  ← cache

    Development (anything else) keeps everything under ``.openagentd/`` in the
    project root::

        .openagentd/data/
            openagentd.db
        .openagentd/wiki/
        .openagentd/workspace/<sid>/uploads/
        .openagentd/config/
        .openagentd/state/
        .openagentd/cache/
    """
    home = Path.home()
    if app_env == "production":
        data = home / ".local" / "share" / "openagentd"
        return {
            "data": data,
            "wiki": home / ".local" / "share" / "openagentd-wiki",
            "workspace": home / ".local" / "share" / "openagentd-workspace",
            "config": home / ".config" / "openagentd",
            "state": home / ".local" / "state" / "openagentd",
            "cache": home / ".cache" / "openagentd",
        }
    root = Path(".openagentd").absolute()
    data = root / "data"
    return {
        "data": data,
        "wiki": root / "wiki",
        "workspace": root / "workspace",
        "config": root / "config",
        "state": root / "state",
        "cache": root / "cache",
    }


class Settings(BaseSettings):
    ZAI_API_KEY: SecretStr | None = None
    GOOGLE_API_KEY: SecretStr | None = None
    OPENAI_API_KEY: SecretStr | None = None
    OPENROUTER_API_KEY: SecretStr | None = None
    NVIDIA_API_KEY: SecretStr | None = None
    XAI_API_KEY: SecretStr | None = None
    DEEPSEEK_API_KEY: SecretStr | None = None
    NINJA_API_KEY: SecretStr | None = None

    # AWS Bedrock — region and optional named profile.
    # AWS_BEDROCK_REGION: override the region for Bedrock API calls.
    #   Falls back to AWS_DEFAULT_REGION env var, then "us-east-1".
    # AWS_BEDROCK_PROFILE: named profile from ~/.aws/credentials.
    #   None (default) uses the standard boto3 credential chain
    #   (env vars AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, instance profile, etc.).
    AWS_BEDROCK_REGION: str | None = None
    AWS_BEDROCK_PROFILE: str | None = None

    # 9Router (https://github.com/decolua/9router) — local proxy that exposes
    # an OpenAI-compatible /v1/chat/completions endpoint. Generate the API key
    # from the 9Router dashboard (default: http://localhost:20128).
    ROUTER9_API_KEY: SecretStr = Field(
        default=SecretStr("sk_9router"), description="Required for 9Router provider"
    )
    ROUTER9_BASE_URL: str = "http://localhost:20128/v1"

    # CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) — local proxy
    # that exposes OpenAI/Gemini/Claude-compatible endpoints. We talk to it
    # via its OpenAI-compatible surface.
    CLIPROXY_API_KEY: SecretStr = Field(
        default=SecretStr("sk_cliproxy"), description="Required for cliproxy provider"
    )
    CLIPROXY_BASE_URL: str = "http://localhost:8317/v1"

    # Ollama (local daemon) — OpenAI-compatible endpoint at
    # http://localhost:11434/v1 by default. The daemon ignores auth, but
    # the OpenAI client requires a non-empty Authorization header — so
    # OLLAMA_API_KEY defaults to "ollama" (Ollama's documented placeholder).
    # Cloud models are reached through the same daemon by suffixing the
    # model name with "-cloud" after running "ollama signin".
    OLLAMA_API_KEY: SecretStr = Field(
        default=SecretStr("ollama"), description="Used for local Ollama provider"
    )
    OLLAMA_BASE_URL: str = "http://localhost:11434/v1"

    # Vertex AI API key (Google Cloud key, NOT an AI Studio key)
    # Obtain from: https://console.cloud.google.com/expressmode
    VERTEXAI_API_KEY: SecretStr | None = None
    # Optional: set both to use normal mode (project-scoped URL + full model catalog)
    # Leave unset to use express mode (no project required)
    GOOGLE_CLOUD_PROJECT: str | None = None
    GOOGLE_CLOUD_LOCATION: str = "global"

    # Environment — controls data directory, log level defaults, etc.
    # Values: "production" | "development"
    APP_ENV: str = "production"

    # API Server
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 4082
    API_RELOAD: bool = False
    CORS_ORIGINS: list[str] = ["*"]

    # ── XDG-aligned roots ────────────────────────────────────────────────
    # Empty string means "derive from APP_ENV" (see validator).
    # Override with an absolute path if needed.
    #
    # data:      irreplaceable internal data (SQLite DB)
    # config:    hand-edited config (agents, skills, prompts, .env)
    # state:     logs, telemetry, OTEL rollups
    # cache:     regeneratable throwaway
    # workspace: per-session agent workspaces — ``{workspace}/<sid>``;
    #            user uploads land at ``{workspace}/<sid>/uploads/``
    OPENAGENTD_DATA_DIR: str = ""
    OPENAGENTD_CONFIG_DIR: str = ""
    OPENAGENTD_STATE_DIR: str = ""
    OPENAGENTD_CACHE_DIR: str = ""
    OPENAGENTD_WORKSPACE_DIR: str = ""

    # Agents directory — contains per-agent .md files.
    # Empty string means "derive from OPENAGENTD_CONFIG_DIR" → ``{CONFIG_DIR}/agents``.
    # Override with an absolute or working-directory-relative path.
    AGENTS_DIR: str = ""

    # Skills directory — contains {skill-name}/SKILL.md subdirectories.
    # Empty string means "derive from OPENAGENTD_CONFIG_DIR" → ``{CONFIG_DIR}/skills``.
    SKILLS_DIR: str = ""

    # User-defined plugin directories — colon-separated absolute paths.
    # Empty string means "derive from CONFIG_DIR" (→ ``{CONFIG_DIR}/plugins``).
    # CONFIG_DIR itself is per-environment (project-local in dev, ``~/.config/openagentd``
    # in production) so a single dir is enough — no separate "global" dir needed.
    # Each ``.py`` file in this dir is loaded at agent-build time and may
    # subscribe to hook events (see app/agent/plugins/).  Files prefixed with
    # ``_`` are skipped so authors can stash helper modules alongside plugins.
    OPENAGENTD_PLUGINS_DIRS: str = ""

    # Logging — defaults to INFO in production, DEBUG in development
    LOG_LEVEL: str = "INFO"  # DEBUG, INFO, WARNING, ERROR

    DATABASE_URL: SecretStr = SecretStr("")

    # Wiki directory — shared wiki store (USER.md, topics/, notes/).
    # Empty string means "derive from APP_ENV" (→ ``.openagentd/wiki`` in dev,
    # ``~/.local/share/openagentd-wiki`` in production).
    OPENAGENTD_WIKI_DIR: str = ""

    model_config = SettingsConfigDict(
        # Load order: project .env first, then ~/.config/openagentd/.env on top.
        # Values in later files take priority, so the user's home config
        # always wins over the project default — and either can be absent.
        env_file=[
            ".env",
            str(Path.home() / ".config" / "openagentd" / ".env"),
        ],
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def _resolve_env_defaults(self) -> "Settings":
        # ── Resolve the 4 XDG roots from APP_ENV when not explicitly set ──
        defaults = _default_dirs(self.APP_ENV)

        if not self.OPENAGENTD_DATA_DIR:
            self.OPENAGENTD_DATA_DIR = str(defaults["data"])
        if not self.OPENAGENTD_CONFIG_DIR:
            self.OPENAGENTD_CONFIG_DIR = str(defaults["config"])
        if not self.OPENAGENTD_STATE_DIR:
            self.OPENAGENTD_STATE_DIR = str(defaults["state"])
        if not self.OPENAGENTD_CACHE_DIR:
            self.OPENAGENTD_CACHE_DIR = str(defaults["cache"])
        if not self.OPENAGENTD_WORKSPACE_DIR:
            self.OPENAGENTD_WORKSPACE_DIR = str(defaults["workspace"])

        data = Path(self.OPENAGENTD_DATA_DIR)
        config = Path(self.OPENAGENTD_CONFIG_DIR)

        # DATABASE_URL: default to SQLite inside DATA_DIR if not explicitly set
        if not self.DATABASE_URL.get_secret_value():
            self.DATABASE_URL = SecretStr(
                f"sqlite+aiosqlite:///{data / 'openagentd.db'}"
            )

        # Agents directory — defaults to ``{CONFIG_DIR}/agents``.
        if not self.AGENTS_DIR:
            self.AGENTS_DIR = str(config / "agents")

        # Skills directory — defaults to ``{CONFIG_DIR}/skills``.
        if not self.SKILLS_DIR:
            self.SKILLS_DIR = str(config / "skills")

        # Plugins directory — defaults to ``{CONFIG_DIR}/plugins``.  Set the
        # env var to a colon-separated list to load from extra paths (rare).
        if not self.OPENAGENTD_PLUGINS_DIRS:
            self.OPENAGENTD_PLUGINS_DIRS = str(config / "plugins")

        # Wiki directory.
        if not self.OPENAGENTD_WIKI_DIR:
            self.OPENAGENTD_WIKI_DIR = str(defaults["wiki"])

        return self

    def plugin_dirs(self) -> list[Path]:
        """Return the configured plugin directories as ``Path`` objects.

        Empty entries are dropped; non-existent directories are kept (the
        loader skips them).  Order is preserved — earlier directories
        win on duplicate filenames.
        """
        return [Path(p) for p in self.OPENAGENTD_PLUGINS_DIRS.split(":") if p.strip()]


settings = Settings()  # pyright: ignore[reportCallIssue]
