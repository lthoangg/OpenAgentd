"""
Manual scenario tests for LSP diagnostics and LspHook.
Run with: uv run python tests/manual/lsp_scenarios.py
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.agent.hooks.lsp import LspHook
from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.schemas.chat import ToolCall, FunctionCall
from app.services.lsp.managed import managed_lsp_tools
from app.services.lsp.manager import LspManager, check_lsp_diagnostics, lsp_manager

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results = []


def check(label, got, expected):
    ok = got == expected
    sym = PASS if ok else FAIL
    results.append((sym, label))
    print(f"  {sym}  {label}")
    if not ok:
        print(f"       got:      {got}")
        print(f"       expected: {expected}")


async def run_mocked_scenarios(tmp_path):
    print("\n── Running Mocked LSP Scenarios ──")
    manager = LspManager()

    # We will simulate the stdin/stdout streams
    from tests.services.test_lsp import MockStreamReader, MockStreamWriter, MockProcess

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
                                    "start": {"line": 1, "character": 4},
                                    "end": {"line": 1, "character": 8},
                                },
                                "severity": 1,
                                "message": "Syntax error: invalid syntax",
                                "source": "mock-lsp",
                            }
                        ],
                    },
                }
            )

    stdin = MockStreamWriter(on_write=on_write)
    proc = MockProcess(stdout, stdin)

    import json

    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec,
        patch("shutil.which", return_value="/usr/bin/mock-lsp"),
        patch("app.services.lsp.manager.lsp_manager", manager),
    ):
        mock_exec.return_value = proc

        file_path = tmp_path / "mock_test.py"
        file_path.write_text("def foo(\n", encoding="utf-8")

        # Test 1: get_diagnostics directly
        diags = await manager.get_diagnostics(file_path, tmp_path)
        check("Mocked 1: diagnostics length", len(diags), 1)
        check(
            "Mocked 2: diagnostic message",
            diags[0]["message"],
            "Syntax error: invalid syntax",
        )

        # Test 2: check_lsp_diagnostics formatting
        report = await check_lsp_diagnostics(file_path, tmp_path)
        expected_report = "[LSP Diagnostics]\n- mock_test.py:2:5: error: Syntax error: invalid syntax (mock-lsp)"
        check("Mocked 3: formatted report", report, expected_report)

        # Test 3: LspHook interception
        sandbox = SandboxConfig(workspace=str(tmp_path))
        set_sandbox(sandbox)
        try:
            hook = LspHook()
            tc = ToolCall(
                id="call_1",
                type="function",
                function=FunctionCall(
                    name="patch",
                    arguments=json.dumps(
                        {
                            "patch_text": (
                                "*** Begin Patch\n"
                                "*** Add File: mock_test.py\n"
                                "+def foo(\n"
                                "*** End Patch\n"
                            )
                        }
                    ),
                ),
            )

            async def handler(ctx, state, tool_call):
                return "Patch applied successfully. Updated paths:\nmock_test.py"

            res = await hook.wrap_tool_call(None, None, tc, handler)
            check(
                "Mocked 4: hook result contains tool output",
                "Patch applied successfully" in res,
                True,
            )
            check(
                "Mocked 5: hook result contains diagnostics",
                "[LSP Diagnostics]" in res,
                True,
            )
            check(
                "Mocked 6: hook result has formatted error",
                "error: Syntax error: invalid syntax" in res,
                True,
            )
        finally:
            set_sandbox(None)
            await manager.stop()


async def run_real_scenarios(tmp_path, lang_id, cmd):
    print(f"\n── Running Real LSP Scenarios using {cmd[0]} (lang: {lang_id}) ──")
    tmp_path.mkdir(parents=True, exist_ok=True)

    # Ensure manager is started
    lsp_manager.start()

    # Write an invalid file
    if lang_id == "python":
        file_path = tmp_path / "real_test.py"
        file_path.write_text("def foo(\n", encoding="utf-8")
    elif lang_id == "typescript":
        file_path = tmp_path / "real_test.ts"
        file_path.write_text("const x: number = 'hello';\n", encoding="utf-8")
    else:
        file_path = tmp_path / f"real_test.{lang_id}"
        file_path.write_text("invalid code", encoding="utf-8")

    print(f"  Writing invalid file: {file_path.name}")

    # Test 1: get_diagnostics should return diagnostics
    report = await check_lsp_diagnostics(file_path, tmp_path)
    print(f"  Diagnostics report:\n{report}")

    # We check that a report was produced and contains "[LSP Diagnostics]"
    check("Real 1: report is not None for invalid file", report is not None, True)
    if report:
        check("Real 2: report contains header", "[LSP Diagnostics]" in report, True)
        if lang_id == "typescript":
            check(
                "Real 2b: managed TypeScript reports the type mismatch",
                "not assignable to type 'number'" in report,
                True,
            )

    # Write a valid file
    if lang_id == "python":
        file_path.write_text("def foo():\n    pass\n", encoding="utf-8")
    elif lang_id == "typescript":
        file_path.write_text("const x: number = 42;\n", encoding="utf-8")

    print(f"  Writing valid file: {file_path.name}")

    # Test 2: check_lsp_diagnostics should return None
    report_valid = await check_lsp_diagnostics(file_path, tmp_path)
    check("Real 3: report is None for valid file", report_valid, None)

    await lsp_manager.stop()


async def main():
    print("=== LSP Scenario Tests ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)

        # 1. Run mocked scenarios to verify correctness of our code independently of environment
        await run_mocked_scenarios(tmp_path)

        # 2. Try to find a real LSP server on the system
        real_lang = None
        real_cmd = None
        for lang, cmds in [
            (
                "python",
                [["pyright-langserver", "--stdio"], ["pylsp"], ["ruff", "server"]],
            ),
            ("typescript", [["typescript-language-server", "--stdio"]]),
            ("go", [["gopls"]]),
            ("c", [["clangd"]]),
        ]:
            for cmd in cmds:
                if shutil.which(cmd[0]):
                    real_lang = lang
                    real_cmd = cmd
                    break
            if real_lang:
                break

        if real_lang and real_cmd:
            try:
                await run_real_scenarios(tmp_path / "system", real_lang, real_cmd)
            except Exception as e:
                print(f"  ⚠️ Real scenario failed: {e}")
        else:
            print(
                "\n⚠️ No real LSP server detected on this system. Skipping real scenarios."
            )

        managed_typescript = managed_lsp_tools.typescript_command(
            tmp_path / "managed-typescript"
        )
        if managed_typescript is not None:
            try:
                await run_real_scenarios(
                    tmp_path / "managed-typescript",
                    "typescript",
                    managed_typescript[0],
                )
            except Exception as e:
                print(f"  ⚠️ Managed TypeScript scenario failed: {e}")
                results.append((FAIL, "Managed TypeScript scenario completes"))
        else:
            print(
                "\n⚠️ Managed TypeScript component is not installed. "
                "Run `uv run openagentd lsp install typescript` to exercise it."
            )

    print("\n=== Summary ===")
    passed = sum(1 for r in results if r[0] == PASS)
    failed = sum(1 for r in results if r[0] == FAIL)
    print(f"Total: {len(results)} tests. Passed: {passed}, Failed: {failed}")
    if failed > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
