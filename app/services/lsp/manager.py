import asyncio
import json
import os
import shutil
from contextlib import suppress
from pathlib import Path

from loguru import logger

from app.services.lsp.client import LspClient


_CACHED_USER_PATH: str | None = None
_USER_PATH_LOCK = asyncio.Lock()
_USER_PATH_TIMEOUT_SECONDS = 3.0
_PATH_OUTPUT_PREFIX = "__OPENAGENTD_PATH__"


async def _get_user_path(*, force_refresh: bool = False) -> str:
    """Return the user's login-shell PATH, not the minimal GUI-app PATH."""
    global _CACHED_USER_PATH
    if _CACHED_USER_PATH is not None and not force_refresh:
        return _CACHED_USER_PATH

    async with _USER_PATH_LOCK:
        if _CACHED_USER_PATH is not None and not force_refresh:
            return _CACHED_USER_PATH

        try:
            from app.agent.tools.builtin import shell_runtime

            shell_bin = shell_runtime.acceptable()
            argv = shell_runtime.build_argv(
                shell_bin, f'printf "{_PATH_OUTPUT_PREFIX}%s\\n" "$PATH"'
            )
            proc = await asyncio.create_subprocess_exec(
                shell_bin,
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.DEVNULL,
            )
            try:
                stdout, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=_USER_PATH_TIMEOUT_SECONDS
                )
            except TimeoutError:
                with suppress(ProcessLookupError):
                    proc.kill()
                with suppress(ProcessLookupError):
                    await proc.wait()
                raise
            if proc.returncode == 0:
                for line in reversed(stdout.decode().splitlines()):
                    if line.startswith(_PATH_OUTPUT_PREFIX):
                        path = line.removeprefix(_PATH_OUTPUT_PREFIX).strip()
                        if path:
                            _CACHED_USER_PATH = path
                            return path
        except Exception as exc:
            logger.debug("lsp_login_shell_path_probe_failed error={!r}", exc)

        _CACHED_USER_PATH = os.environ.get("PATH", "")
        return _CACHED_USER_PATH


# Cap how many diagnostics we inject per file so a badly-broken file can't
# flood the model's context window. Errors are prioritised over warnings.
MAX_DIAGNOSTICS_PER_FILE = 20

EXTENSION_TO_LANG = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".go": "go",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
}

# Python is the one language where a single server can't do everything: a type
# checker (ty / pyright) catches type errors but not lint, and ruff catches lint
# but not types. So for Python we run *every* installed server in this list and
# merge their diagnostics. All other languages have one canonical server that
# does syntax + types + lint in one process, so they stay single-server.
PYTHON_MULTI_SERVERS = [
    ["ty", "server"],
    ["ruff", "server"],
    ["pyright-langserver", "--stdio"],
    ["pylsp"],
]

LSP_COMMANDS = {
    "python": [
        ["pyright-langserver", "--stdio"],
        ["pylsp"],
        ["ruff", "server"],
    ],
    "typescript": [
        ["typescript-language-server", "--stdio"],
        ["vtsls", "--stdio"],
    ],
    "typescriptreact": [
        ["typescript-language-server", "--stdio"],
        ["vtsls", "--stdio"],
    ],
    "javascript": [
        ["typescript-language-server", "--stdio"],
        ["vtsls", "--stdio"],
    ],
    "javascriptreact": [
        ["typescript-language-server", "--stdio"],
        ["vtsls", "--stdio"],
    ],
    "go": [
        ["gopls"],
    ],
    "c": [
        ["clangd"],
    ],
    "cpp": [
        ["clangd"],
    ],
}


def find_project_root(file_path: Path, workspace_root: Path, lang_id: str) -> Path:
    """Find the nearest directory that is the true project root for *lang_id*.

    Walks upward from the file toward *workspace_root* in two passes:

    Pass 1 — strong anchors only (unambiguous project roots).
      A match here is returned immediately.

    Pass 2 — weak anchors (``package.json`` / ``jsconfig.json``).
      These are common enough to appear in nested utility packages, so we
      only use them if no strong anchor was found anywhere in the walk.
      We return the *highest* (outermost) weak match found, because in a
      monorepo the root ``package.json`` is closer to the true project
      boundary than a nested one deep inside ``src/``.

    Falls back to *workspace_root* when nothing is found.
    """
    file_path = file_path.resolve()
    workspace_root = workspace_root.resolve()

    # Strong anchors: unambiguous TS project boundaries.
    # A tsconfig.json defines exactly one TS project; lockfiles mean the
    # directory owns its own dependency tree.
    strong: dict[str, list[str]] = {
        "typescript": [
            "tsconfig.json",
            "tsconfig.app.json",
            "bun.lockb",
            "bun.lock",
            "yarn.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
        ],
        "typescriptreact": [
            "tsconfig.json",
            "tsconfig.app.json",
            "bun.lockb",
            "bun.lock",
            "yarn.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
        ],
        "javascript": [
            "jsconfig.json",
            "bun.lockb",
            "bun.lock",
            "yarn.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
        ],
        "javascriptreact": [
            "jsconfig.json",
            "bun.lockb",
            "bun.lock",
            "yarn.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
        ],
        "rust": ["Cargo.toml", "Cargo.lock"],
        "python": [
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "pyrightconfig.json",
            "venv",
            ".venv",
        ],
        "go": ["go.mod", "go.work"],
        "c": ["compile_commands.json", "compile_flags.txt", ".clangd"],
        "cpp": ["compile_commands.json", "compile_flags.txt", ".clangd"],
    }

    # Weak anchors: present in almost every JS directory, so only used as a
    # last resort and we prefer the outermost (highest) match.
    weak: dict[str, list[str]] = {
        "typescript": ["package.json"],
        "typescriptreact": ["package.json"],
        "javascript": ["package.json"],
        "javascriptreact": ["package.json"],
        "python": ["requirements.txt", "Pipfile", "setup.cfg"],
    }

    strong_triggers = strong.get(lang_id, [])
    weak_triggers = weak.get(lang_id, [])

    if not strong_triggers and not weak_triggers:
        return workspace_root

    weak_candidate: Path | None = None
    curr = file_path.parent

    while curr.exists() and curr != curr.parent:
        # Pass 1: strong anchor — return immediately.
        for trigger in strong_triggers:
            if (curr / trigger).exists():
                return curr

        # Pass 2: note weak matches but keep walking — we want the outermost.
        if weak_triggers:
            for trigger in weak_triggers:
                if (curr / trigger).exists():
                    weak_candidate = curr
                    break

        if curr == workspace_root:
            break
        curr = curr.parent

    return weak_candidate if weak_candidate is not None else workspace_root


def _python_tools_from_pyproject(project_root: Path) -> list[list[str]]:
    """Infer preferred Python LSP commands from a project's pyproject.toml.

    We look at declared dependencies/dev-dependencies and config tables to see
    which tooling the project actually uses, then map those to LSP-speaking
    commands. Example: this repo pins ``ty`` and ``ruff``, so we prefer
    ``ty server`` (type checking) and ``ruff server`` (lint) over pyright.
    """
    pyproject = project_root / "pyproject.toml"
    if not pyproject.exists():
        return []

    try:
        import tomllib

        with pyproject.open("rb") as f:
            data = tomllib.load(f)
    except Exception as e:
        logger.warning("Failed to parse pyproject.toml for LSP detection: {}", e)
        return []

    # Gather a flat haystack of declared dependency strings + tool tables.
    haystack: list[str] = []
    project = data.get("project", {})
    haystack += [str(d) for d in project.get("dependencies", [])]
    for group in (project.get("optional-dependencies", {}) or {}).values():
        haystack += [str(d) for d in group]
    for group in (data.get("dependency-groups", {}) or {}).values():
        haystack += [str(d) for d in group]
    tool_tables = set((data.get("tool", {}) or {}).keys())

    def declares(name: str) -> bool:
        if name in tool_tables:
            return True
        return any(
            dep.split("[")[0]
            .split(">")[0]
            .split("=")[0]
            .split("<")[0]
            .split("~")[0]
            .strip()
            .lower()
            == name
            for dep in haystack
        )

    cmds: list[list[str]] = []
    # ``ty`` — Astral's type checker, speaks LSP via ``ty server``.
    if declares("ty"):
        cmds.append(["ty", "server"])
    # ``ruff`` — lint/format diagnostics via ``ruff server``.
    if declares("ruff"):
        cmds.append(["ruff", "server"])
    # ``pyright`` explicitly declared.
    if declares("pyright") or (project_root / "pyrightconfig.json").exists():
        cmds.append(["pyright-langserver", "--stdio"])
    # ``python-lsp-server`` (pylsp).
    if declares("python-lsp-server") or declares("pylsp"):
        cmds.append(["pylsp"])
    return cmds


def detect_project_lsp_commands(lang_id: str, project_root: Path) -> list[list[str]]:
    """Return LSP commands the *project* is configured to use, most-preferred first.

    Falls back to an empty list when nothing project-specific is detected, in
    which case the caller uses the generic defaults.
    """
    try:
        if lang_id == "python":
            return _python_tools_from_pyproject(project_root)

        # TypeScript/JavaScript: pin to typescript-language-server for any
        # Node project (package.json / tsconfig.json / jsconfig.json).
        if lang_id in (
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ):
            markers = ("package.json", "tsconfig.json", "jsconfig.json")
            if any((project_root / m).exists() for m in markers):
                return [["typescript-language-server", "--stdio"]]

        # Go / C / C++ have a single canonical server; defer to generic defaults.
        return []
    except Exception as e:
        logger.warning("Project LSP detection failed for {}: {}", lang_id, e)
        return []


def _build_ts_init_options(project_root: Path) -> dict:
    """Build initializationOptions for typescript-language-server.

    Reads tsconfig.json to propagate compilerOptions.types so explicitly
    declared type packages (e.g. ``bun-types``, ``@types/node``) are honoured,
    silencing false-positive "Cannot find module" errors for bun builtins and
    path aliases.
    """
    options: dict = {"preferences": {"includeInlayParameterNameHints": "none"}}

    tsconfig_path = project_root / "tsconfig.json"
    if not tsconfig_path.exists():
        tsconfig_path = project_root / "tsconfig.app.json"

    if tsconfig_path.exists():
        try:
            with tsconfig_path.open(encoding="utf-8") as f:
                tsconfig = json.load(f)
            compiler_opts = tsconfig.get("compilerOptions", {})
            if "types" in compiler_opts:
                options.setdefault("compilerOptions", {})["types"] = list(
                    compiler_opts["types"]
                )
        except Exception as e:
            logger.warning("Failed to read tsconfig for LSP init options: {}", e)

    # Detect bun projects and inject bun-types so `bun:test` etc. resolve.
    if (project_root / "bun.lockb").exists() or (project_root / "bun.lock").exists():
        types: list[str] = options.setdefault("compilerOptions", {}).setdefault(
            "types", []
        )
        if "bun-types" not in types:
            types.append("bun-types")

    return options


def _build_init_options(lang_id: str, project_root: Path) -> dict | None:
    """Return server-specific initializationOptions for *lang_id*, or None.

    This is the single dispatch point for per-language init options. Adding
    support for a new language (e.g. gopls, clangd) means adding a branch here
    rather than scattering language checks across the manager.
    """
    if lang_id in {"typescript", "typescriptreact", "javascript", "javascriptreact"}:
        return _build_ts_init_options(project_root)
    return None


class LspManager:
    # How long a language stays marked "unsupported" before we retry detection.
    # Lets a user install a server (or fix settings) mid-session without a restart.
    UNSUPPORTED_TTL = 300.0

    def __init__(self):
        # Keyed by (workspace_root, lang_id, command-tuple) so a language can
        # have multiple servers (Python: ty + ruff) cached side by side.
        self._clients: dict[tuple[str, str, tuple[str, ...]], LspClient] = {}
        self._cleanup_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        # lang_id -> monotonic time when it was marked unsupported.
        self._unsupported_langs: dict[str, float] = {}

    def _is_unsupported(self, lang_id: str) -> bool:
        marked_at = self._unsupported_langs.get(lang_id)
        if marked_at is None:
            return False
        if asyncio.get_running_loop().time() - marked_at > self.UNSUPPORTED_TTL:
            # TTL expired — clear it so detection runs again.
            self._unsupported_langs.pop(lang_id, None)
            return False
        return True

    def _mark_unsupported(self, lang_id: str) -> None:
        self._unsupported_langs[lang_id] = asyncio.get_running_loop().time()

    def start(self):
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        try:
            while True:
                await asyncio.sleep(60)
                now = asyncio.get_running_loop().time()
                to_remove = []
                async with self._lock:
                    for key, client in list(self._clients.items()):
                        # Check if client has been idle for more than 5 minutes
                        if now - client.last_used_at > 300:
                            logger.info("Stopping idle LSP client for key={}", key)
                            await client.stop()
                            to_remove.append(key)
                        # Also clean up if process died
                        elif client.process and client.process.returncode is not None:
                            logger.warning("LSP client process died for key={}", key)
                            await client.stop()
                            to_remove.append(key)

                    for key in to_remove:
                        self._clients.pop(key, None)
        except asyncio.CancelledError:
            pass

    async def _detect_commands(
        self, lang_id: str, project_root: Path | None = None
    ) -> list[list[str]]:
        """Resolve which LSP server command(s) to run for *lang_id*.

        Returns a list because Python runs multiple complementary servers
        (type checker + linter) and merges their diagnostics. Every other
        language returns a single-element list (one canonical server).

        Resolution order (first tier that yields anything wins):
          1. Project config   — tools declared in pyproject.toml / Cargo.toml /
                                 package.json that are actually on PATH. The
                                 project knows its own toolchain, so it beats
                                 the global settings.yaml fallback.
          2. Runtime settings — ``lsp: {python: [ty]}`` in settings.yaml.
          3. Generic defaults — Python: every installed server in
                                 PYTHON_MULTI_SERVERS; others: first installed
                                 entry of LSP_COMMANDS.
        """
        user_path = await _get_user_path()

        def available(cmd: list[str]) -> bool:
            return shutil.which(cmd[0], path=user_path) is not None

        # 1. Project-config-aware detection (may yield several for Python).
        if project_root is not None:
            project_cmds = [
                cmd
                for cmd in detect_project_lsp_commands(lang_id, project_root)
                if available(cmd)
            ]
            if project_cmds:
                logger.info(
                    "Using project-configured LSP for {}: {}", lang_id, project_cmds
                )
                return project_cmds

        # 2. Runtime settings (settings.yaml) — global fallback.
        try:
            from app.core.runtime_settings import load_runtime_settings

            cfg = load_runtime_settings()
            custom_cmd = cfg.lsp.get(lang_id)
            if not custom_cmd and lang_id == "typescriptreact":
                custom_cmd = cfg.lsp.get("typescript")
            elif not custom_cmd and lang_id == "javascriptreact":
                custom_cmd = cfg.lsp.get("javascript")
            if custom_cmd:
                return [custom_cmd]
        except Exception as e:
            logger.warning("Failed to load runtime settings for LSP command: {}", e)

        # 3. Generic defaults.
        if lang_id == "python":
            # Run every installed Python server so types + lint are both covered.
            installed = [c for c in PYTHON_MULTI_SERVERS if available(c)]
            return installed

        for cmd in LSP_COMMANDS.get(lang_id, []):
            if available(cmd):
                return [cmd]
        return []

    async def get_clients(self, workspace_root: Path, lang_id: str) -> list[LspClient]:
        """Return the running LSP client(s) for a language, starting them lazily.

        Python yields multiple (type checker + linter); other languages yield
        at most one. Servers are cached per (workspace, lang, command).
        """
        if self._is_unsupported(lang_id):
            return []

        async with self._lock:
            cmds = await self._detect_commands(lang_id, project_root=workspace_root)
            if not cmds:
                logger.info("No LSP server found for language: {}", lang_id)
                self._mark_unsupported(lang_id)
                return []

            clients: list[LspClient] = []
            for cmd in cmds:
                key = (str(workspace_root), lang_id, tuple(cmd))
                client = self._clients.get(key)
                if client and client.process and client.process.returncode is None:
                    clients.append(client)
                    continue
                if client:
                    # Replace a dead client.
                    await client.stop()
                    self._clients.pop(key, None)

                client = LspClient(
                    cmd,
                    workspace_root,
                    init_options=_build_init_options(lang_id, workspace_root),
                    env={**os.environ, "PATH": await _get_user_path()},
                )
                try:
                    await client.start()
                    self._clients[key] = client
                    clients.append(client)
                except Exception as e:
                    logger.error(
                        "Failed to start LSP client {} for {}: {}", cmd, lang_id, e
                    )

            if not clients:
                # Every candidate failed to start — back off so we don't retry
                # a broken toolchain on every keystroke.
                self._mark_unsupported(lang_id)
            return clients

    async def get_diagnostics(
        self, file_path: Path, workspace_root: Path
    ) -> list[dict]:
        ext = file_path.suffix.lower()
        lang_id = EXTENSION_TO_LANG.get(ext)
        if not lang_id:
            return []

        proj_root = find_project_root(file_path, workspace_root, lang_id)
        clients = await self.get_clients(proj_root, lang_id)
        if not clients:
            return []

        uri = file_path.resolve().as_uri()

        # Read file content once and share it across all servers.
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as e:
            logger.error("Failed to read file for LSP diagnostics: {}", e)
            return []

        # Query every server for this language concurrently (Python: ty + ruff)
        # and merge their diagnostics. Each server's own failure is isolated.
        results = await asyncio.gather(
            *(self._diagnostics_from(c, uri, lang_id, content) for c in clients),
            return_exceptions=True,
        )
        merged: list[dict] = []
        for r in results:
            if isinstance(r, BaseException):
                logger.warning("LSP server diagnostics failed: {}", r)
                continue
            merged.extend(r)
        return merged

    async def _diagnostics_from(
        self, client: LspClient, uri: str, lang_id: str, content: str
    ) -> list[dict]:
        """Open the document on one server, settle, and return its diagnostics."""
        # Register an event for this URI BEFORE opening so we never miss a
        # publish that arrives between didOpen and our first wait.
        event = client.reset_diagnostics(uri)
        try:
            await client.open_or_update_document(uri, lang_id, content)
        except Exception as e:
            logger.error("Failed to open document on LSP server: {}", e)
            return []

        diagnostics = await self._await_settled(client, uri, event)

        try:
            await client.close_document(uri)
        except Exception as e:
            logger.warning("Failed to send didClose to LSP: {}", e)

        return diagnostics

    async def _await_settled(self, client: LspClient, uri: str, event) -> list[dict]:
        """Wait for diagnostics, debouncing only when needed.

        Fast linters (ty, ruff) publish exactly once and go quiet, so paying a
        fixed settle window on every check is pure latency. We instead:

          1. Wait for the first publish (bounded by OVERALL_TIMEOUT).
          2. If it is NON-EMPTY, trust it and return immediately — the common
             "file has errors" case is now instant.
          3. If it is EMPTY, the server may be using the pyright pattern of
             ack-then-real-diagnostics, so briefly debounce to see whether a
             real batch follows before concluding the file is clean.
        """
        overall_timeout = 3.0
        settle_window = 0.25
        loop = asyncio.get_running_loop()
        deadline = loop.time() + overall_timeout

        # 1. Wait for the first publish (or overall timeout).
        try:
            await asyncio.wait_for(event.wait(), timeout=overall_timeout)
        except asyncio.TimeoutError:
            logger.warning("Timeout waiting for LSP diagnostics for {}", uri)
            return client.get_diagnostics(uri)

        # 2. Non-empty first publish → trust it, no debounce.
        diagnostics = client.get_diagnostics(uri)
        if diagnostics:
            return diagnostics

        # 3. Empty first publish → debounce briefly in case real diagnostics
        #    follow (e.g. pyright's empty-then-real sequence).
        while True:
            event.clear()
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(
                    event.wait(), timeout=min(settle_window, remaining)
                )
            except asyncio.TimeoutError:
                # Quiet window elapsed with no further publish → settled clean.
                break
            # A new publish arrived; if it carries diagnostics we can stop early.
            if client.get_diagnostics(uri):
                break

        return client.get_diagnostics(uri)

    async def stop(self):
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

        async with self._lock:
            for key, client in list(self._clients.items()):
                logger.info("Stopping LSP client for key={}", key)
                await client.stop()
            self._clients.clear()


# Singleton instance
lsp_manager = LspManager()


async def check_lsp_diagnostics(file_path: Path, workspace_root: Path) -> str | None:
    """Run LSP diagnostics on the given file and return a formatted report if errors/warnings exist."""
    try:
        diagnostics = await lsp_manager.get_diagnostics(file_path, workspace_root)
    except Exception as e:
        logger.error("Failed to get LSP diagnostics: {}", e)
        return None

    if not diagnostics:
        return None

    # Make the path relative to workspace root if possible
    try:
        rel_path = file_path.relative_to(workspace_root)
    except ValueError:
        rel_path = file_path.name

    # Keep only errors (severity 1) and warnings (severity 2). Sort errors
    # first, then by position, so a capped report surfaces the most important
    # problems instead of an arbitrary slice.
    relevant = [d for d in diagnostics if d.get("severity", 1) in (1, 2)]
    relevant.sort(
        key=lambda d: (
            d.get("severity", 1),
            d.get("range", {}).get("start", {}).get("line", 0),
            d.get("range", {}).get("start", {}).get("character", 0),
        )
    )
    if not relevant:
        return None

    total = len(relevant)
    capped = relevant[:MAX_DIAGNOSTICS_PER_FILE]

    formatted_lines = []
    for diag in capped:
        severity_str = "error" if diag.get("severity", 1) == 1 else "warning"
        start = diag.get("range", {}).get("start", {})
        line = start.get("line", 0) + 1
        char = start.get("character", 0) + 1
        msg = diag.get("message", "").strip()
        source = diag.get("source", "LSP")
        formatted_lines.append(
            f"- {rel_path}:{line}:{char}: {severity_str}: {msg} ({source})"
        )

    if total > len(capped):
        formatted_lines.append(f"- …and {total - len(capped)} more in {rel_path}")

    return "[LSP Diagnostics]\n" + "\n".join(formatted_lines)
