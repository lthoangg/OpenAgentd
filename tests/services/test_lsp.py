import asyncio
import json
from pathlib import Path

import pytest
from unittest.mock import AsyncMock, patch

from app.services.lsp.client import LspClient
from app.services.lsp.manager import LspManager, check_lsp_diagnostics


class MockStreamReader:
    def __init__(self):
        self.queue = asyncio.Queue()

    async def readline(self):
        item = await self.queue.get()
        if item == b"":
            return b""
        return item

    async def readexactly(self, n):
        item = await self.queue.get()
        return item

    def feed_message(self, message: dict):
        body = json.dumps(message).encode("utf-8")
        self.queue.put_nowait(f"Content-Length: {len(body)}\r\n".encode("utf-8"))
        self.queue.put_nowait(b"\r\n")
        self.queue.put_nowait(body)

    def feed_eof(self):
        self.queue.put_nowait(b"")


class MockStreamWriter:
    def __init__(self, on_write=None):
        self.on_write = on_write

    def write(self, data):
        if self.on_write:
            self.on_write(data)

    async def drain(self):
        pass


class MockProcess:
    def __init__(self, stdout, stdin):
        self.stdout = stdout
        self.stdin = stdin
        self.returncode = None

    async def wait(self):
        return 0

    def terminate(self):
        self.returncode = 0


def _only_pyright(exe, path=None):
    """shutil.which stub: only pyright resolves, so Python stays single-server
    (keeps tests that aren't about the multi-server merge fast and focused)."""
    return "/usr/bin/pyright-langserver" if exe == "pyright-langserver" else None


@pytest.mark.asyncio
async def test_lsp_client_lifecycle(tmp_path):
    stdout = MockStreamReader()

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        body = parts[1]
        try:
            msg = json.loads(body.decode("utf-8"))
            if msg.get("method") == "initialize":
                stdout.feed_message(
                    {
                        "jsonrpc": "2.0",
                        "id": msg["id"],
                        "result": {"capabilities": {"textDocumentSync": 1}},
                    }
                )
            elif msg.get("method") == "textDocument/didOpen":
                uri = msg["params"]["textDocument"]["uri"]
                stdout.feed_message(
                    {
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {
                            "uri": uri,
                            "diagnostics": [
                                {
                                    "range": {
                                        "start": {"line": 9, "character": 4},
                                        "end": {"line": 9, "character": 10},
                                    },
                                    "severity": 1,
                                    "message": "Expected expression",
                                    "source": "pyright",
                                }
                            ],
                        },
                    }
                )
        except Exception as e:
            print("Error in mock on_write:", e)

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc

        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()

        assert client.process is proc

        # Test getting diagnostics
        file_path = tmp_path / "test.py"
        file_path.write_text("def foo():\n    pass\n", encoding="utf-8")

        uri = file_path.resolve().as_uri()
        event = client.reset_diagnostics(uri)

        await client.open_or_update_document(uri, "python", "def foo():\n    pass\n")

        await asyncio.wait_for(event.wait(), timeout=1.0)
        diagnostics = client.get_diagnostics(uri)
        assert len(diagnostics) == 1
        assert diagnostics[0]["message"] == "Expected expression"
        assert diagnostics[0]["severity"] == 1

        await client.stop()
        assert client.process is None


@pytest.mark.asyncio
async def test_lsp_client_stop_reads_shutdown_response_before_cancelling_reader(
    tmp_path,
):
    """A responsive server receives exit instead of waiting out shutdown timeout."""
    stdout = MockStreamReader()
    messages: list[dict] = []

    def on_write(data):
        message = json.loads(data.split(b"\r\n\r\n", 1)[1])
        messages.append(message)
        if message.get("method") == "shutdown":
            stdout.feed_message({"jsonrpc": "2.0", "id": message["id"], "result": None})

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))
    client = LspClient(["mock-lsp"], tmp_path)
    client.process = proc
    client._read_task = asyncio.create_task(client._read_loop())

    async def immediate_timeout(awaitable, timeout):
        task = asyncio.ensure_future(awaitable)
        for _ in range(3):
            await asyncio.sleep(0)
            if task.done():
                return task.result()
        task.cancel()
        raise TimeoutError

    with patch("app.services.lsp.client.asyncio.wait_for", new=immediate_timeout):
        await client.stop()

    assert [message.get("method") for message in messages] == ["shutdown", "exit"]
    assert "params" not in messages[0]
    assert client._read_task is None
    assert client.process is None


@pytest.mark.asyncio
async def test_get_diagnostics_moves_project_probe_and_file_read_off_event_loop(
    tmp_path,
):
    """Project discovery and reading are synchronous filesystem work."""
    manager = LspManager()
    file_path = tmp_path / "test.py"
    file_path.write_text("x = 1\n", encoding="utf-8")
    thread_calls = []

    async def run_in_thread(func, *args, **kwargs):
        thread_calls.append(func)
        return func(*args, **kwargs)

    with (
        patch("app.services.lsp.manager.asyncio.to_thread", side_effect=run_in_thread),
        patch.object(
            manager, "get_clients", new_callable=AsyncMock, return_value=[object()]
        ),
        patch.object(
            manager,
            "_diagnostics_from",
            new_callable=AsyncMock,
            return_value=[{"message": "diagnostic"}],
        ),
    ):
        assert await manager.get_diagnostics(file_path, tmp_path) == [
            {"message": "diagnostic"}
        ]

    assert [call.__name__ for call in thread_calls] == [
        "find_project_root",
        "_read_diagnostics_file",
    ]


@pytest.mark.asyncio
async def test_lsp_manager_starts_unrelated_workspace_clients_concurrently(tmp_path):
    """A slow server start must not serialize another workspace's start."""
    manager = LspManager()
    first_started = asyncio.Event()
    both_started = asyncio.Event()
    allow_starts = asyncio.Event()
    started_workspaces: set[Path] = set()

    class BlockingClient:
        def __init__(self, command, workspace_root, **kwargs):
            self.workspace_root = workspace_root
            self.process = None

        async def start(self):
            started_workspaces.add(self.workspace_root)
            first_started.set()
            if len(started_workspaces) == 2:
                both_started.set()
            await allow_starts.wait()
            self.process = MockProcess(None, None)

        async def stop(self):
            self.process = None

    with (
        patch.object(
            manager,
            "_detect_commands",
            new_callable=AsyncMock,
            return_value=[["mock-lsp"]],
        ),
        patch("app.services.lsp.manager.LspClient", BlockingClient),
    ):
        first = asyncio.create_task(manager.get_clients(tmp_path / "one", "python"))
        await first_started.wait()
        second = asyncio.create_task(manager.get_clients(tmp_path / "two", "python"))
        try:
            await asyncio.wait_for(both_started.wait(), timeout=0.1)
        finally:
            allow_starts.set()
            await asyncio.gather(first, second, return_exceptions=True)


@pytest.mark.asyncio
async def test_lsp_manager_starts_same_workspace_client_once(tmp_path):
    """Concurrent callers for one workspace/language share its startup."""
    manager = LspManager()
    first_started = asyncio.Event()
    allow_start = asyncio.Event()
    starts = 0

    class BlockingClient:
        def __init__(self, command, workspace_root, **kwargs):
            self.process = None

        async def start(self):
            nonlocal starts
            starts += 1
            first_started.set()
            await allow_start.wait()
            self.process = MockProcess(None, None)

        async def stop(self):
            self.process = None

    with (
        patch.object(
            manager,
            "_detect_commands",
            new_callable=AsyncMock,
            return_value=[["mock-lsp"]],
        ),
        patch("app.services.lsp.manager.LspClient", BlockingClient),
    ):
        first = asyncio.create_task(manager.get_clients(tmp_path, "python"))
        await first_started.wait()
        second = asyncio.create_task(manager.get_clients(tmp_path, "python"))
        try:
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(second), timeout=0.1)
            assert starts == 1
        finally:
            allow_start.set()
            clients_one, clients_two = await asyncio.gather(first, second)

    assert clients_one[0] is clients_two[0]


@pytest.mark.asyncio
async def test_lsp_manager_stop_blocks_startup_and_allows_reuse_afterward(tmp_path):
    """Stopping waits for an in-flight start, then permits a later restart."""
    manager = LspManager()
    first_started = asyncio.Event()
    allow_start = asyncio.Event()
    stopped = asyncio.Event()

    class BlockingClient:
        def __init__(self, command, workspace_root, **kwargs):
            self.process = None
            self.last_used_at = 0.0

        async def start(self):
            first_started.set()
            await allow_start.wait()
            self.process = MockProcess(None, None)

        async def stop(self):
            self.process = None
            stopped.set()

    with (
        patch.object(
            manager,
            "_detect_commands",
            new_callable=AsyncMock,
            return_value=[["mock-lsp"]],
        ),
        patch("app.services.lsp.manager.LspClient", BlockingClient),
    ):
        starting = asyncio.create_task(manager.get_clients(tmp_path, "python"))
        await first_started.wait()
        stopping = asyncio.create_task(manager.stop())
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(stopping), timeout=0.1)
        assert await manager.get_clients(tmp_path / "other", "python") == []

        allow_start.set()
        await starting
        await stopping
        assert stopped.is_set()
        assert manager._clients == {}

        assert await manager.get_clients(tmp_path, "python")


@pytest.mark.asyncio
async def test_lsp_manager_caching_and_diagnostics(tmp_path):
    manager = LspManager()
    stdout = MockStreamReader()

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        body = parts[1]
        msg = json.loads(body.decode("utf-8"))
        if msg.get("method") == "initialize":
            stdout.feed_message({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        elif msg.get("method") == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": uri,
                        "diagnostics": [
                            {
                                "range": {
                                    "start": {"line": 0, "character": 0},
                                    "end": {"line": 0, "character": 5},
                                },
                                "severity": 2,
                                "message": "Unused import",
                                "source": "ruff",
                            }
                        ],
                    },
                }
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    # Only pyright is installed → single Python server (keeps this test focused
    # on caching rather than the multi-server merge path).
    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch("shutil.which", side_effect=_only_pyright),
    ):
        mock_exec.return_value = proc

        file_path = tmp_path / "test.py"
        file_path.write_text("import os\n", encoding="utf-8")

        # First call spawns the client
        diagnostics = await manager.get_diagnostics(file_path, tmp_path)
        assert len(diagnostics) == 1
        assert diagnostics[0]["message"] == "Unused import"

        # Second call should reuse the cached client
        clients1 = await manager.get_clients(tmp_path, "python")
        clients2 = await manager.get_clients(tmp_path, "python")
        assert len(clients1) == 1
        assert clients1[0] is clients2[0]

        await manager.stop()


@pytest.mark.asyncio
async def test_lsp_manager_unsupported(tmp_path):
    manager = LspManager()

    with patch("shutil.which", return_value=None):
        file_path = tmp_path / "test.py"
        file_path.write_text("import os\n", encoding="utf-8")

        diagnostics = await manager.get_diagnostics(file_path, tmp_path)
        assert diagnostics == []

        # Should be marked as unsupported
        assert "python" in manager._unsupported_langs

        # Subsequent requests should return [] immediately without checking paths
        clients = await manager.get_clients(tmp_path, "python")
        assert clients == []


@pytest.mark.asyncio
async def test_lsp_manager_unsupported_ttl_expires(tmp_path):
    """A language marked unsupported is retried once the TTL elapses, so a
    user installing a server mid-session doesn't need a restart."""
    manager = LspManager()
    manager.UNSUPPORTED_TTL = 0.05  # shrink for the test

    with patch("shutil.which", return_value=None):
        assert await manager.get_clients(tmp_path, "python") == []
        assert manager._is_unsupported("python") is True

    # After the TTL elapses, the mark clears and detection runs again.
    await asyncio.sleep(0.06)
    assert manager._is_unsupported("python") is False


class _FakeSettleClient:
    """Minimal client stub exposing the diagnostics API _await_settled uses."""

    def __init__(self):
        self._diags: list[dict] = []
        self.event = asyncio.Event()

    def get_diagnostics(self, uri):
        return self._diags

    def publish(self, diags):
        self._diags = diags
        self.event.set()


@pytest.mark.asyncio
async def test_await_settled_trusts_nonempty_first_publish_fast():
    """A non-empty first publish returns immediately — no settle-window tax."""
    manager = LspManager()
    client = _FakeSettleClient()
    client.publish([{"severity": 1, "message": "boom"}])

    loop = asyncio.get_running_loop()
    t0 = loop.time()
    diags = await manager._await_settled(client, "file:///x.py", client.event)
    elapsed = loop.time() - t0

    assert diags == [{"severity": 1, "message": "boom"}]
    # Should be effectively instant — well under the empty-case settle window.
    assert elapsed < 0.1


@pytest.mark.asyncio
async def test_await_settled_debounces_empty_then_real():
    """An empty first publish is debounced, catching real diagnostics that
    arrive a moment later (the pyright ack-then-real pattern)."""
    manager = LspManager()
    client = _FakeSettleClient()
    client.publish([])  # empty ack first

    async def push_real_soon():
        await asyncio.sleep(0.05)
        client.publish([{"severity": 1, "message": "late error"}])

    asyncio.create_task(push_real_soon())
    diags = await manager._await_settled(client, "file:///x.py", client.event)
    assert diags == [{"severity": 1, "message": "late error"}]


@pytest.mark.asyncio
async def test_typescript_diagnostics_use_longer_cold_start_timeout():
    from unittest.mock import MagicMock

    manager = LspManager()
    client = MagicMock()
    client.open_or_update_document = AsyncMock()
    client.close_document = AsyncMock()
    event = asyncio.Event()
    client.reset_diagnostics.return_value = event
    client.get_diagnostics.return_value = []

    with patch.object(
        manager, "_await_settled", new=AsyncMock(return_value=[])
    ) as wait:
        await manager._diagnostics_from(
            client, "file:///x.ts", "typescript", "const x = 1"
        )

    assert wait.await_args.kwargs == {
        "overall_timeout": 10.0,
        "empty_settle_window": 1.0,
    }


@pytest.mark.asyncio
async def test_check_lsp_diagnostics_formatting(tmp_path):
    manager = LspManager()
    stdout = MockStreamReader()

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        body = parts[1]
        msg = json.loads(body.decode("utf-8"))
        if msg.get("method") == "initialize":
            stdout.feed_message({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        elif msg.get("method") == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": uri,
                        "diagnostics": [
                            {
                                "range": {
                                    "start": {"line": 2, "character": 5},
                                    "end": {"line": 2, "character": 10},
                                },
                                "severity": 1,
                                "message": "Syntax error",
                                "source": "pyright",
                            },
                            {
                                "range": {
                                    "start": {"line": 4, "character": 0},
                                    "end": {"line": 4, "character": 10},
                                },
                                "severity": 2,
                                "message": "Style warning",
                                "source": "ruff",
                            },
                            {
                                "range": {
                                    "start": {"line": 5, "character": 0},
                                    "end": {"line": 5, "character": 10},
                                },
                                "severity": 3,  # Info (should be filtered out)
                                "message": "Info message",
                                "source": "ruff",
                            },
                        ],
                    },
                }
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch("shutil.which", side_effect=_only_pyright),
        patch("app.services.lsp.manager.lsp_manager", manager),
    ):
        mock_exec.return_value = proc

        file_path = tmp_path / "src" / "test.py"
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text("import os\n", encoding="utf-8")

        report = await check_lsp_diagnostics(file_path, tmp_path)

        assert report is not None
        assert "[LSP Diagnostics]" in report
        assert "- src/test.py:3:6: error: Syntax error (pyright)" in report
        assert "- src/test.py:5:1: warning: Style warning (ruff)" in report
        assert "Info message" not in report

        await manager.stop()


@pytest.mark.asyncio
async def test_check_lsp_diagnostics_groups_repeated_messages_to_save_tokens(tmp_path):
    file_path = tmp_path / "src" / "example.ts"
    file_path.parent.mkdir()
    file_path.write_text("const broken = true;\n", encoding="utf-8")
    message = "Parameter 'b' implicitly has an 'any' type."
    diagnostics = [
        {
            "range": {"start": {"line": line - 1, "character": character - 1}},
            "severity": 1,
            "message": message,
            "source": "ts",
        }
        for line, character in ((159, 36), (297, 36), (324, 50))
    ]

    with patch(
        "app.services.lsp.manager.lsp_manager.get_diagnostics",
        new=AsyncMock(return_value=diagnostics),
    ):
        report = await check_lsp_diagnostics(file_path, tmp_path)

    assert report == (
        "[LSP Diagnostics]\n"
        "- src/example.ts:159:36, 297:36, 324:50: error: "
        "Parameter 'b' implicitly has an 'any' type. (ts)"
    )


@pytest.mark.asyncio
async def test_lsp_hook_intercepts_and_formats(tmp_path):
    from app.agent.hooks.lsp import LspHook
    from app.agent.schemas.chat import ToolCall, FunctionCall
    from unittest.mock import MagicMock

    manager = LspManager()
    stdout = MockStreamReader()

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        body = parts[1]
        msg = json.loads(body.decode("utf-8"))
        if msg.get("method") == "initialize":
            stdout.feed_message({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        elif msg.get("method") == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": uri,
                        "diagnostics": [
                            {
                                "range": {
                                    "start": {"line": 2, "character": 5},
                                    "end": {"line": 2, "character": 10},
                                },
                                "severity": 1,
                                "message": "Syntax error",
                                "source": "pyright",
                            }
                        ],
                    },
                }
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch("shutil.which", side_effect=_only_pyright),
        patch("app.services.lsp.manager.lsp_manager", manager),
    ):
        mock_exec.return_value = proc

        file_path = tmp_path / "test.py"
        file_path.write_text("import os\n", encoding="utf-8")

        # Set up active sandbox context
        from app.agent.denied_paths import (
            DeniedPathsConfig as SandboxConfig,
            set_denied_paths as set_sandbox,
        )

        sandbox = SandboxConfig(workspace=str(tmp_path))
        set_sandbox(sandbox)

        try:
            hook = LspHook()

            # Create a mock tool call
            tc = ToolCall(
                id="call_1",
                type="function",
                function=FunctionCall(
                    name="patch",
                    arguments=json.dumps(
                        {
                            "patch_text": (
                                "*** Begin Patch\n"
                                "*** Add File: test.py\n"
                                "+import os\n"
                                "*** End Patch\n"
                            )
                        }
                    ),
                ),
            )

            # Mock handler that returns the original tool output
            async def handler(ctx, state, tool_call):
                return "Patch applied successfully. Updated paths:\ntest.py"

            ctx = MagicMock()
            state = MagicMock()

            result = await hook.wrap_tool_call(ctx, state, tc, handler)

            assert "Patch applied successfully" in result
            assert "[LSP Diagnostics]" in result
            assert "- test.py:3:6: error: Syntax error (pyright)" in result
        finally:
            set_sandbox(None)
            await manager.stop()


@pytest.mark.asyncio
async def test_lsp_manager_custom_command_from_settings(tmp_path):
    manager = LspManager()

    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings
    from app.core import config as config_module

    # Point the config dir to our temp path
    with patch.object(config_module.settings, "OPENAGENTD_CONFIG_DIR", str(tmp_path)):
        cfg = RuntimeSettings(lsp={"python": ["ty"]})
        save_runtime_settings(cfg)

        # settings.yaml command is honoured (no project_root → skips tier 1).
        cmds = await manager._detect_commands("python")
        assert cmds == [["ty"]]


@pytest.mark.asyncio
async def test_lsp_hook_skipped_when_disabled(tmp_path):
    """When constructed with enabled=False (non-coding mode), the hook is a
    transparent pass-through and never touches the LSP manager."""
    from app.agent.hooks.lsp import LspHook
    from app.agent.schemas.chat import ToolCall, FunctionCall
    from unittest.mock import MagicMock

    hook = LspHook(enabled=False)

    tc = ToolCall(
        id="call_1",
        type="function",
        function=FunctionCall(
            name="write",
            arguments=json.dumps({"path": "test.py", "content": "import os\n"}),
        ),
    )

    async def handler(ctx, state, tool_call):
        return "Written 10 bytes to test.py"

    ctx = MagicMock()
    state = MagicMock()

    # If the hook tried to run diagnostics this would raise (no sandbox set).
    result = await hook.wrap_tool_call(ctx, state, tc, handler)
    assert result == "Written 10 bytes to test.py"


def test_find_project_root(tmp_path):
    from app.services.lsp.manager import find_project_root

    # Go: no manifest, falls back to workspace root.
    src = tmp_path / "src"
    src.mkdir()
    main_go = src / "main.go"
    main_go.write_text("package main", encoding="utf-8")

    assert find_project_root(main_go, tmp_path, "go") == tmp_path

    # Python without any manifest falls back to workspace root.
    some_py = src / "some.py"
    assert find_project_root(some_py, tmp_path, "python") == tmp_path


def test_find_project_root_ts_strong_anchor_beats_nested_package_json(tmp_path):
    """tsconfig.json (strong) must win over a nested package.json (weak).

    Layout:
      workspace/
        apps/
          frontend/
            tsconfig.json   ← strong anchor
            package.json
            src/
              lib/
                utils/
                  package.json  ← weak: nested utility package
                  Button.tsx    ← edited file

    The nearest package.json is in utils/, but the real TS project root is
    frontend/ because that's where tsconfig.json lives.
    """
    from app.services.lsp.manager import find_project_root

    frontend = tmp_path / "apps" / "frontend"
    utils = frontend / "src" / "lib" / "utils"
    utils.mkdir(parents=True)

    (frontend / "tsconfig.json").write_text("{}", encoding="utf-8")
    (frontend / "package.json").write_text("{}", encoding="utf-8")
    (utils / "package.json").write_text(
        "{}", encoding="utf-8"
    )  # nested — should be ignored
    button = utils / "Button.tsx"
    button.write_text("export {}", encoding="utf-8")

    root = find_project_root(button, tmp_path, "typescriptreact")
    assert root == frontend, f"Expected {frontend}, got {root}"


def test_find_project_root_ts_weak_anchor_outermost(tmp_path):
    """With only package.json files (no tsconfig), pick the outermost one.

    Layout:
      workspace/
        package.json        ← outermost weak anchor (monorepo root)
        apps/
          frontend/
            package.json    ← inner weak anchor
            src/
              Button.tsx

    Neither has a tsconfig.json, so we fall back to weak anchors and prefer
    the outermost — the monorepo root is the broadest valid scope.
    """
    from app.services.lsp.manager import find_project_root

    frontend = tmp_path / "apps" / "frontend"
    src = frontend / "src"
    src.mkdir(parents=True)

    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    (frontend / "package.json").write_text("{}", encoding="utf-8")
    button = src / "Button.tsx"
    button.write_text("export {}", encoding="utf-8")

    root = find_project_root(button, tmp_path, "typescriptreact")
    assert root == tmp_path, f"Expected workspace root {tmp_path}, got {root}"


def test_find_project_root_ts_lockfile_is_strong_anchor(tmp_path):
    """A lockfile (bun.lockb, yarn.lock, etc.) is a strong anchor — it beats
    a closer package.json that has no lockfile."""
    from app.services.lsp.manager import find_project_root

    frontend = tmp_path / "apps" / "frontend"
    utils = frontend / "src" / "utils"
    utils.mkdir(parents=True)

    (frontend / "package.json").write_text("{}", encoding="utf-8")
    (frontend / "bun.lockb").write_bytes(b"")  # strong anchor
    (utils / "package.json").write_text("{}", encoding="utf-8")  # nested weak
    helper = utils / "helper.ts"
    helper.write_text("export {}", encoding="utf-8")

    root = find_project_root(helper, tmp_path, "typescript")
    assert root == frontend, f"Expected {frontend}, got {root}"


def test_detect_project_lsp_commands_python(tmp_path):
    """A pyproject.toml that declares ty + ruff should prefer those servers."""
    from app.services.lsp.manager import detect_project_lsp_commands

    (tmp_path / "pyproject.toml").write_text(
        """
[project]
name = "demo"
dependencies = ["httpx>=0.28"]

[dependency-groups]
dev = ["ruff>=0.15", "ty>=0.0.33,<0.1", "pytest>=9"]

[tool.ruff]
target-version = "py313"
""",
        encoding="utf-8",
    )

    cmds = detect_project_lsp_commands("python", tmp_path)
    # ty (type checker) preferred first, then ruff (lint). pyright/pylsp absent.
    assert ["ty", "server"] in cmds
    assert ["ruff", "server"] in cmds
    assert cmds.index(["ty", "server"]) < cmds.index(["ruff", "server"])
    assert ["pylsp"] not in cmds


def test_detect_project_lsp_commands_no_pyproject(tmp_path):
    from app.services.lsp.manager import detect_project_lsp_commands

    assert detect_project_lsp_commands("python", tmp_path) == []
    # No manifest → defer to generic defaults (empty here).
    assert detect_project_lsp_commands("typescript", tmp_path) == []


def test_detect_project_python_tool_versions(tmp_path):
    """Exact ``==`` pins are captured; ranges and bare declarations resolve to
    ``None`` (PyPI latest) at install time."""
    from app.services.lsp.manager import detect_project_python_tool_versions

    (tmp_path / "pyproject.toml").write_text(
        """
[project]
name = "demo"
dependencies = ["ruff==0.16.1"]

[project.optional-dependencies]
dev = ["ty"]

[dependency-groups]
dev = ["ty>=0.0.33,<0.1", "pytest>=9"]
""",
        encoding="utf-8",
    )

    assert detect_project_python_tool_versions(tmp_path) == {
        "ruff": "0.16.1",
        "ty": None,
    }


def test_detect_project_python_tool_versions_no_pyproject(tmp_path):
    from app.services.lsp.manager import detect_project_python_tool_versions

    assert detect_project_python_tool_versions(tmp_path) == {}


def test_detect_project_lsp_commands_typescript(tmp_path):
    from app.services.lsp.manager import detect_project_lsp_commands

    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    assert detect_project_lsp_commands("typescript", tmp_path) == [
        ["typescript-language-server", "--stdio"]
    ]
    # tsconfig.json alone also qualifies, and javascript maps the same way.
    other = tmp_path / "ts_only"
    other.mkdir()
    (other / "tsconfig.json").write_text("{}", encoding="utf-8")
    assert detect_project_lsp_commands("javascript", other) == [
        ["typescript-language-server", "--stdio"]
    ]


@pytest.mark.asyncio
async def test_detect_commands_prefers_project_config(tmp_path):
    """Project-declared servers win over generic defaults, and only the
    declared ones run (ty here — not the full multi-server default list)."""
    manager = LspManager()
    (tmp_path / "pyproject.toml").write_text(
        '[dependency-groups]\ndev = ["ty>=0.0.33"]\n', encoding="utf-8"
    )

    # Everything resolves on PATH, but the project only declares ty.
    with patch("shutil.which", side_effect=lambda exe, path=None: f"/usr/bin/{exe}"):
        cmds = await manager._detect_commands("python", project_root=tmp_path)
        assert cmds == [["ty", "server"]]


@pytest.mark.asyncio
async def test_detect_commands_auto_installs_declared_missing_python_tool(
    tmp_path, monkeypatch
):
    """A project that declares ty/ruff but has none on PATH or bundled gets a
    silent managed install of the pinned version, then runs that server."""
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    (tmp_path / "pyproject.toml").write_text(
        '[dependency-groups]\ndev = ["ty==0.0.33"]\n', encoding="utf-8"
    )
    monkeypatch.setattr(manager_mod.shutil, "which", lambda command, path=None: None)
    monkeypatch.setattr(
        manager_mod, "find_packaged_python_command", lambda command: None
    )

    installed: dict[str, bool] = {}
    ensured: list[tuple[str, str | None]] = []

    def fake_python_tool_command(name, version):
        return [f"/managed/{name}", "server"] if installed.get(name) else None

    async def fake_ensure(name, version):
        ensured.append((name, version))
        installed[name] = True

    monkeypatch.setattr(
        manager_mod.managed_lsp_tools, "python_tool_command", fake_python_tool_command
    )
    monkeypatch.setattr(
        manager_mod.managed_lsp_tools, "ensure_python_tool", fake_ensure
    )

    cmds = await manager._detect_commands("python", project_root=tmp_path)

    assert cmds == [["/managed/ty", "server"]]
    assert ensured == [("ty", "0.0.33")]


@pytest.mark.asyncio
async def test_detect_commands_does_not_auto_install_without_declaration(
    tmp_path, monkeypatch
):
    """Silent installs only happen for project-declared tools; a bare workspace
    with nothing installed must not trigger a download."""
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    monkeypatch.setattr(manager_mod.shutil, "which", lambda command, path=None: None)
    monkeypatch.setattr(
        manager_mod, "find_packaged_python_command", lambda command: None
    )
    ensured: list[tuple[str, str | None]] = []

    async def fake_ensure(name, version):
        ensured.append((name, version))

    monkeypatch.setattr(
        manager_mod.managed_lsp_tools, "ensure_python_tool", fake_ensure
    )

    cmds = await manager._detect_commands("python", project_root=tmp_path)

    assert cmds == []
    assert ensured == []


@pytest.mark.asyncio
async def test_detect_commands_python_defaults_run_all_installed(tmp_path):
    """With no project/settings config, Python runs every installed server so
    type errors (ty) and lint (ruff) are both covered."""
    manager = LspManager()

    # ty + ruff installed; pyright/pylsp absent.
    installed = {"ty", "ruff"}
    with patch(
        "shutil.which",
        side_effect=lambda exe, path=None: (
            f"/usr/bin/{exe}" if exe in installed else None
        ),
    ):
        cmds = await manager._detect_commands("python", project_root=tmp_path)
        assert cmds == [["ty", "server"], ["ruff", "server"]]


@pytest.mark.asyncio
async def test_detect_commands_non_python_single_server(tmp_path):
    """Non-Python languages stay single-server even though _detect_commands
    returns a list."""
    manager = LspManager()
    with patch("shutil.which", side_effect=lambda exe, path=None: f"/usr/bin/{exe}"):
        assert await manager._detect_commands("go", project_root=tmp_path) == [
            ["gopls"]
        ]
        assert await manager._detect_commands("c", project_root=tmp_path) == [
            ["clangd"]
        ]


@pytest.mark.asyncio
async def test_detect_commands_uses_login_shell_path_for_desktop_lsp_servers(
    tmp_path, monkeypatch
):
    """Desktop sidecars must resolve user-installed LSP servers outside PATH."""
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    checked_paths = []

    async def fake_get_user_path(*, force_refresh=False):
        return "/Users/test/.local/bin:/opt/homebrew/bin"

    def fake_which(command, path=None):
        checked_paths.append(path)
        return "/Users/test/.local/bin/ty" if command == "ty" else None

    monkeypatch.setattr(manager_mod, "_get_user_path", fake_get_user_path)
    monkeypatch.setattr(manager_mod.shutil, "which", fake_which)

    commands = await manager._detect_commands("python", project_root=tmp_path)

    assert commands == [["ty", "server"]]
    assert checked_paths
    assert all(
        path == "/Users/test/.local/bin:/opt/homebrew/bin" for path in checked_paths
    )


@pytest.mark.asyncio
async def test_detect_commands_falls_back_to_packaged_python_servers(
    tmp_path, monkeypatch
):
    """Packaged ty and ruff work even when the login-shell PATH is empty."""
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    monkeypatch.setattr(manager_mod.shutil, "which", lambda command, path=None: None)
    monkeypatch.setattr(
        manager_mod,
        "find_packaged_python_command",
        lambda command: (
            [f"/runtime/bin/{command}", "server"] if command in {"ty", "ruff"} else None
        ),
    )

    assert await manager._detect_commands("python", project_root=tmp_path) == [
        ["/runtime/bin/ty", "server"],
        ["/runtime/bin/ruff", "server"],
    ]


@pytest.mark.asyncio
async def test_detect_commands_uses_ready_managed_typescript_component(
    tmp_path, monkeypatch
):
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    monkeypatch.setattr(manager_mod.shutil, "which", lambda command, path=None: None)
    command = [
        "/cache/lsp/bin/bun",
        "/cache/lsp/node_modules/.bin/typescript-language-server",
        "--stdio",
    ]
    monkeypatch.setattr(
        manager_mod.managed_lsp_tools,
        "typescript_command",
        lambda root: (
            command,
            Path("/cache/lsp/node_modules/typescript/lib/tsserver.js"),
        ),
    )

    assert await manager._detect_commands("typescript", project_root=tmp_path) == [
        command
    ]


@pytest.mark.asyncio
async def test_detect_commands_announces_missing_typescript_component(
    tmp_path, monkeypatch
):
    import app.services.lsp.manager as manager_mod

    manager = LspManager()
    monkeypatch.setattr(manager_mod.shutil, "which", lambda command, path=None: None)
    monkeypatch.setattr(
        manager_mod.managed_lsp_tools, "typescript_command", lambda root: None
    )
    required = AsyncMock()
    monkeypatch.setattr(
        manager_mod.managed_lsp_tools, "announce_typescript_required", required
    )

    assert await manager._detect_commands("typescript", project_root=tmp_path) == []
    required.assert_awaited_once_with(tmp_path)


@pytest.mark.asyncio
async def test_missing_managed_typescript_is_rechecked_after_user_installs(tmp_path):
    manager = LspManager()

    with patch.object(manager, "_detect_commands", new=AsyncMock(return_value=[])):
        assert await manager.get_clients(tmp_path, "typescript") == []

    assert "typescript" not in manager._unsupported_langs


@pytest.mark.asyncio
async def test_python_multi_server_merges_diagnostics(tmp_path):
    """ty + ruff both run for Python and their diagnostics are merged — so a
    file with a type error (ty) and a lint warning (ruff) surfaces both."""
    manager = LspManager()

    # Map each server command to the single diagnostic it publishes.
    server_diags = {
        "ty": {
            "range": {
                "start": {"line": 4, "character": 11},
                "end": {"line": 4, "character": 18},
            },
            "severity": 1,
            "message": "Type error",
            "source": "ty",
        },
        "ruff": {
            "range": {
                "start": {"line": 0, "character": 0},
                "end": {"line": 0, "character": 5},
            },
            "severity": 2,
            "message": "Unused import",
            "source": "ruff",
        },
    }

    def make_proc(diag):
        stdout = MockStreamReader()

        def on_write(data):
            parts = data.split(b"\r\n\r\n", 1)
            if len(parts) < 2:
                return
            msg = json.loads(parts[1].decode("utf-8"))
            if msg.get("method") == "initialize":
                stdout.feed_message({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
            elif msg.get("method") == "textDocument/didOpen":
                uri = msg["params"]["textDocument"]["uri"]
                stdout.feed_message(
                    {
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {"uri": uri, "diagnostics": [diag]},
                    }
                )

        return MockProcess(stdout, MockStreamWriter(on_write=on_write))

    # exec is dispatched by command: ty → ty's proc, ruff → ruff's proc.
    async def fake_exec(*cmd, **kwargs):
        exe = cmd[0]
        return make_proc(server_diags[exe])

    installed = {"ty", "ruff"}
    with (
        patch("asyncio.create_subprocess_exec", side_effect=fake_exec),
        patch(
            "shutil.which",
            side_effect=lambda exe, path=None: (
                f"/usr/bin/{exe}" if exe in installed else None
            ),
        ),
    ):
        file_path = tmp_path / "demo.py"
        file_path.write_text("import os\n", encoding="utf-8")

        diagnostics = await manager.get_diagnostics(file_path, tmp_path)
        messages = sorted(d["message"] for d in diagnostics)
        assert messages == ["Type error", "Unused import"]

        report = await check_lsp_diagnostics(file_path, tmp_path)
        assert "error: Type error (ty)" in report
        assert "warning: Unused import (ruff)" in report

        await manager.stop()


@pytest.mark.asyncio
async def test_check_lsp_diagnostics_caps_and_sorts(tmp_path):
    """Diagnostics are capped and errors are surfaced before warnings."""
    from app.services.lsp.manager import MAX_DIAGNOSTICS_PER_FILE
    import app.services.lsp.manager as mgr

    file_path = tmp_path / "big.py"
    file_path.write_text("x = 1\n", encoding="utf-8")

    # Build many warnings + a couple of errors at high line numbers.
    fake = []
    for i in range(MAX_DIAGNOSTICS_PER_FILE + 5):
        fake.append(
            {
                "range": {"start": {"line": i, "character": 0}},
                "severity": 2,
                "message": f"warn {i}",
                "source": "ruff",
            }
        )
    fake.append(
        {
            "range": {"start": {"line": 999, "character": 0}},
            "severity": 1,
            "message": "real error",
            "source": "ty",
        }
    )

    async def fake_get_diagnostics(fp, wr):
        return fake

    with patch.object(mgr.lsp_manager, "get_diagnostics", new=fake_get_diagnostics):
        report = await mgr.check_lsp_diagnostics(file_path, tmp_path)

    assert report is not None
    lines = report.split("\n")
    # Header + capped lines + "and N more" summary.
    body = [ln for ln in lines if ln.startswith("- ")]
    assert len(body) == MAX_DIAGNOSTICS_PER_FILE + 1  # +1 for the "…more" line
    # Error sorts first despite being on line 1000.
    assert "error: real error" in body[0]
    assert body[-1].startswith("- …and")


# ---------------------------------------------------------------------------
# Regression tests for the four feedback issues
# ---------------------------------------------------------------------------


# Issue 1 — Monorepo/subfolder: workspaceFolders sent in initialize
# -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_lsp_client_sends_workspace_folders_in_initialize(tmp_path):
    """LspClient must include workspaceFolders in the LSP initialize request so
    that servers (e.g. tsserver) can handle monorepo sub-projects correctly."""
    stdout = MockStreamReader()
    captured_params: list[dict] = []

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            captured_params.append(msg.get("params", {}))
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc
        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()
        await client.stop()

    assert len(captured_params) == 1
    params = captured_params[0]

    # workspaceFolders list must be present and point at the workspace root.
    assert "workspaceFolders" in params, "initialize must include workspaceFolders"
    folders = params["workspaceFolders"]
    assert len(folders) == 1
    assert folders[0]["uri"] == tmp_path.as_uri()
    assert folders[0]["name"] == tmp_path.name

    # Workspace capability must be advertised.
    caps = params.get("capabilities", {})
    assert caps.get("workspace", {}).get("workspaceFolders") is True


@pytest.mark.asyncio
async def test_lsp_client_advertises_hierarchical_document_symbol_support(tmp_path):
    """Without this capability, servers (pyright, ty) fall back to flat

    SymbolInformation — location = the whole declaration (e.g. starting at
    "async"/"def") with no identifier-only position available. Hierarchical
    DocumentSymbol adds selectionRange (just the identifier), which
    LspManager.navigation's flatten() needs to report a position that
    actually resolves in a follow-up go_to_definition/find_references/hover
    call.
    """
    stdout = MockStreamReader()
    captured_params: list[dict] = []

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            captured_params.append(msg.get("params", {}))
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc
        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()
        await client.stop()

    assert len(captured_params) == 1
    caps = captured_params[0].get("capabilities", {})
    assert (
        caps.get("textDocument", {})
        .get("documentSymbol", {})
        .get("hierarchicalDocumentSymbolSupport")
        is True
    )


@pytest.mark.asyncio
async def test_lsp_monorepo_subfolder_uses_subfolder_root(tmp_path):
    """In a monorepo the LSP client for a sub-project is started with the
    sub-project root as its workspace_root, not the top-level workspace."""
    from app.services.lsp.manager import find_project_root, LspManager

    # Monorepo layout:
    # tmp_path/
    #   frontend/
    #     package.json
    #     src/
    #       App.tsx
    frontend = tmp_path / "frontend"
    (frontend / "src").mkdir(parents=True)
    (frontend / "package.json").write_text("{}", encoding="utf-8")
    app_tsx = frontend / "src" / "App.tsx"
    app_tsx.write_text("export default function App() { return null; }\n")

    proj_root = find_project_root(app_tsx, tmp_path, "typescriptreact")
    # Must resolve to the sub-project, not the workspace root.
    assert proj_root == frontend

    # The manager must start the client with frontend/ as its workspace root.
    manager = LspManager()
    stdout = MockStreamReader()
    captured_roots: list[str] = []

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            captured_roots.append(msg["params"].get("rootUri", ""))
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))

    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch(
            "shutil.which",
            side_effect=lambda exe, path=None: (
                "/usr/bin/typescript-language-server"
                if exe == "typescript-language-server"
                else None
            ),
        ),
    ):
        mock_exec.return_value = proc
        clients = await manager.get_clients(frontend, "typescriptreact")
        assert len(clients) == 1
        await manager.stop()

    assert len(captured_roots) == 1
    assert captured_roots[0] == frontend.as_uri(), (
        f"Expected rootUri={frontend.as_uri()!r}, got {captured_roots[0]!r}"
    )


# Issue 2 & 3 — bun:test / path-alias noise
# ------------------------------------------


def test_build_ts_init_options_injects_bun_types_for_bun_project(tmp_path):
    """A project with bun.lockb should get bun-types injected into types."""
    from app.services.lsp.manager import _build_ts_init_options

    (tmp_path / "bun.lockb").write_bytes(b"")
    opts = _build_ts_init_options(tmp_path)

    types = opts.get("compilerOptions", {}).get("types", [])
    assert "bun-types" in types, f"Expected bun-types in {types}"


def test_build_ts_init_options_bun_lock_also_triggers(tmp_path):
    """bun.lock (text lockfile, newer Bun) also triggers bun-types injection."""
    from app.services.lsp.manager import _build_ts_init_options

    (tmp_path / "bun.lock").write_text("", encoding="utf-8")
    opts = _build_ts_init_options(tmp_path)

    types = opts.get("compilerOptions", {}).get("types", [])
    assert "bun-types" in types


def test_build_ts_init_options_no_bun_lockfile_no_injection(tmp_path):
    """Without a bun lockfile bun-types must NOT be injected."""
    from app.services.lsp.manager import _build_ts_init_options

    opts = _build_ts_init_options(tmp_path)
    types = opts.get("compilerOptions", {}).get("types", [])
    assert "bun-types" not in types


def test_build_ts_init_options_reads_tsconfig_types(tmp_path):
    """If tsconfig.json already lists explicit types they are forwarded."""
    import json as _json
    from app.services.lsp.manager import _build_ts_init_options

    (tmp_path / "tsconfig.json").write_text(
        _json.dumps({"compilerOptions": {"types": ["node", "jest"], "baseUrl": "."}}),
        encoding="utf-8",
    )
    opts = _build_ts_init_options(tmp_path)
    types = opts.get("compilerOptions", {}).get("types", [])
    assert "node" in types
    assert "jest" in types


def test_build_ts_init_options_points_to_project_typescript(tmp_path):
    from app.services.lsp.manager import _build_ts_init_options

    tsserver = tmp_path / "node_modules" / "typescript" / "lib" / "tsserver.js"
    tsserver.parent.mkdir(parents=True)
    tsserver.write_text("// project typescript", encoding="utf-8")

    assert _build_ts_init_options(tmp_path)["tsserver"]["path"] == str(tsserver)


def test_build_ts_init_options_points_to_managed_typescript(tmp_path, monkeypatch):
    import app.services.lsp.manager as manager_mod

    managed_tsserver = Path("/cache/lsp/typescript/lib/tsserver.js")
    monkeypatch.setattr(
        manager_mod.managed_lsp_tools,
        "typescript_command",
        lambda root: (
            ["bun", "typescript-language-server", "--stdio"],
            managed_tsserver,
        ),
    )

    assert manager_mod._build_ts_init_options(tmp_path)["tsserver"]["path"] == str(
        managed_tsserver
    )


def test_build_ts_init_options_bun_not_duplicated_when_already_in_tsconfig(tmp_path):
    """bun-types is not added twice when tsconfig already lists it."""
    import json as _json
    from app.services.lsp.manager import _build_ts_init_options

    (tmp_path / "bun.lockb").write_bytes(b"")
    (tmp_path / "tsconfig.json").write_text(
        _json.dumps({"compilerOptions": {"types": ["bun-types"]}}),
        encoding="utf-8",
    )
    opts = _build_ts_init_options(tmp_path)
    types = opts.get("compilerOptions", {}).get("types", [])
    assert types.count("bun-types") == 1


@pytest.mark.asyncio
async def test_ts_client_receives_init_options_in_initialize(tmp_path):
    """typescript-language-server must receive initializationOptions in the
    initialize request so tsserver sees bun-types / path aliases."""
    from app.services.lsp.manager import LspManager

    # Create a bun project so bun-types is injected.
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    (tmp_path / "bun.lockb").write_bytes(b"")

    stdout = MockStreamReader()
    captured_init_opts: list = []

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            captured_init_opts.append(msg["params"].get("initializationOptions"))
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))
    manager = LspManager()

    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch(
            "shutil.which",
            side_effect=lambda exe, path=None: (
                "/usr/bin/typescript-language-server"
                if exe == "typescript-language-server"
                else None
            ),
        ),
    ):
        mock_exec.return_value = proc
        await manager.get_clients(tmp_path, "typescript")
        await manager.stop()

    assert len(captured_init_opts) == 1
    init_opts = captured_init_opts[0]
    assert init_opts is not None, "initializationOptions must be sent for TS"
    types = init_opts.get("compilerOptions", {}).get("types", [])
    assert "bun-types" in types, (
        f"bun-types missing from initializationOptions: {init_opts}"
    )


# Issue 4 — Stale diagnostics after didClose
# -------------------------------------------


@pytest.mark.asyncio
async def test_close_document_does_not_clear_diagnostics(tmp_path):
    """close_document must NOT clear _latest_diagnostics.

    Some servers send a final publishDiagnostics on didClose; if we clear
    diagnostics before that publish, re-checking the same file sees stale
    (empty) state instead of the real diagnostics from the next open cycle.
    The invariant: _latest_diagnostics is only cleared by reset_diagnostics().
    """
    stdout = MockStreamReader()

    def on_write(data):
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )
        elif msg.get("method") == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": uri,
                        "diagnostics": [
                            {
                                "range": {"start": {"line": 0, "character": 0}},
                                "severity": 1,
                                "message": "Real error",
                                "source": "ty",
                            }
                        ],
                    },
                }
            )

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc
        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()

        uri = (tmp_path / "test.py").resolve().as_uri()

        # Simulate a full check cycle.
        event = client.reset_diagnostics(uri)
        await client.open_or_update_document(uri, "python", "x: int = 'oops'\n")
        await asyncio.wait_for(event.wait(), timeout=1.0)
        assert client.get_diagnostics(uri) == [
            {
                "range": {"start": {"line": 0, "character": 0}},
                "severity": 1,
                "message": "Real error",
                "source": "ty",
            }
        ]

        # close_document must NOT erase the diagnostics.
        await client.close_document(uri)
        assert client.get_diagnostics(uri) == [
            {
                "range": {"start": {"line": 0, "character": 0}},
                "severity": 1,
                "message": "Real error",
                "source": "ty",
            }
        ], "close_document must not clear _latest_diagnostics"

        await client.stop()


@pytest.mark.asyncio
async def test_server_didclose_publish_does_not_corrupt_next_cycle(tmp_path):
    """A server that sends publishDiagnostics on didClose must not corrupt the
    next check cycle.  reset_diagnostics() claims a new event BEFORE open; any
    post-close publish from the server updates _latest_diagnostics but the new
    event is already installed, so _await_settled sees the fresh state.
    """
    stdout = MockStreamReader()
    open_count = 0

    def on_write(data):
        nonlocal open_count
        parts = data.split(b"\r\n\r\n", 1)
        if len(parts) < 2:
            return
        try:
            msg = json.loads(parts[1].decode("utf-8"))
        except Exception:
            return
        if msg.get("method") == "initialize":
            stdout.feed_message(
                {"jsonrpc": "2.0", "id": msg["id"], "result": {"capabilities": {}}}
            )
        elif msg.get("method") == "textDocument/didOpen":
            open_count += 1
            uri = msg["params"]["textDocument"]["uri"]
            # First open → error.  Second open → clean.
            diags = (
                [
                    {
                        "range": {"start": {"line": 0, "character": 0}},
                        "severity": 1,
                        "message": f"Cycle {open_count} error",
                        "source": "ty",
                    }
                ]
                if open_count == 1
                else []
            )
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {"uri": uri, "diagnostics": diags},
                }
            )
        elif msg.get("method") == "textDocument/didClose":
            # Spec-compliant: server clears diagnostics on close.
            uri = msg["params"]["textDocument"]["uri"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {"uri": uri, "diagnostics": []},
                }
            )

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc
        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()

        uri = (tmp_path / "test.py").resolve().as_uri()

        # Cycle 1 — file has an error.
        event1 = client.reset_diagnostics(uri)
        await client.open_or_update_document(uri, "python", "bad code\n")
        await asyncio.wait_for(event1.wait(), timeout=1.0)
        diags1 = client.get_diagnostics(uri)
        assert len(diags1) == 1 and diags1[0]["message"] == "Cycle 1 error"

        # didClose: server fires an empty publishDiagnostics.
        # This should NOT wipe state owned by the upcoming cycle 2.
        await client.close_document(uri)
        # Brief pause so the close-publish can arrive.
        await asyncio.sleep(0.05)

        # Cycle 2 — reset_diagnostics claims the new event BEFORE open.
        event2 = client.reset_diagnostics(uri)
        await client.open_or_update_document(uri, "python", "good = True\n")
        await asyncio.wait_for(event2.wait(), timeout=1.0)
        diags2 = client.get_diagnostics(uri)
        # Second cycle returns clean (empty), not stale cycle-1 data.
        assert diags2 == [], f"Expected empty diagnostics on cycle 2, got {diags2}"

        await client.stop()


async def test_concurrent_same_document_diagnostics_are_serialized(tmp_path):
    """Concurrent checks must not replace each other's URI event state."""
    stdout = MockStreamReader()

    def on_write(data):
        message = json.loads(data.split(b"\r\n\r\n", 1)[1])
        if message.get("method") == "initialize":
            stdout.feed_message({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        elif message.get("method") in {
            "textDocument/didOpen",
            "textDocument/didChange",
        }:
            document = message["params"]["textDocument"]
            stdout.feed_message(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {
                        "uri": document["uri"],
                        "diagnostics": [{"message": "diagnostic"}],
                    },
                }
            )

    proc = MockProcess(stdout, MockStreamWriter(on_write=on_write))
    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        mock_exec.return_value = proc
        client = LspClient(["mock-lsp"], tmp_path)
        await client.start()

        manager = LspManager()
        uri = (tmp_path / "test.py").resolve().as_uri()
        first, second = await asyncio.wait_for(
            asyncio.gather(
                manager._diagnostics_from(client, uri, "python", "x = 1\n"),
                manager._diagnostics_from(client, uri, "python", "x = 2\n"),
            ),
            timeout=0.2,
        )

        assert first == [{"message": "diagnostic"}]
        assert second == [{"message": "diagnostic"}]
        await client.stop()


@pytest.mark.asyncio
async def test_lsp_react_language_mapping(tmp_path):
    """Verify that .tsx and .jsx map to the correct react language IDs and find project roots."""
    from app.services.lsp.manager import EXTENSION_TO_LANG, find_project_root

    assert EXTENSION_TO_LANG.get(".tsx") == "typescriptreact"
    assert EXTENSION_TO_LANG.get(".jsx") == "javascriptreact"
    assert EXTENSION_TO_LANG.get(".ts") == "typescript"
    assert EXTENSION_TO_LANG.get(".js") == "javascript"

    # Verify project root triggers for react variants
    file_path = tmp_path / "src" / "App.tsx"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text("<div />", encoding="utf-8")

    tsconfig = tmp_path / "tsconfig.json"
    tsconfig.write_text("{}", encoding="utf-8")

    proj_root = find_project_root(file_path, tmp_path, "typescriptreact")
    assert proj_root == tmp_path
