from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "check_portable_tests.py"
    spec = importlib.util.spec_from_file_location("check_portable_tests", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_module()


def _test_fn(body: str) -> str:
    return f"#[tokio::test]\nasync fn a_test() {{\n    {body}\n}}\n"


# The lines below are the ones that failed Windows CI on the v3.59.0 and
# v3.58.0 release PRs, as they were before their fixes.
def test_the_blocking_loop_that_failed_subagent_interrupt_is_caught():
    line = "let build = format!(\"while [ ! -f '{}' ]; do sleep 0.05; done; echo built\", release.display());"
    assert len(mod.check_rust("appv3/crates/agent/tests/subagent_interrupt.rs", _test_fn(line))) == 1


def test_the_environment_read_that_failed_secret_request_is_caught():
    line = r'let shell = json!({"command": "echo \"key=$STRIPE_SECRET_KEY id=$AWS_ACCESS_KEY_ID\"", "secrets": []});'
    assert len(mod.check_rust("appv3/crates/agent/tests/secret_request.rs", _test_fn(line))) == 1


def test_touch_and_printf_and_wc_are_caught():
    for line in ["let c = format!(\"touch '{}'\", p.display());", "let c = \"printf %s x | wc -c\";"]:
        assert mod.check_rust("appv3/crates/agent/tests/x.rs", _test_fn(line)), line


def test_a_command_branched_on_windows_passes():
    body = (
        "let c = if cfg!(windows) { \"Write-Output $env:KEY\" } else { \"echo $KEY\" };\n"
        "    let j = json!({\"command\": \"echo $KEY\"});"
    )
    assert mod.check_rust("appv3/crates/agent/tests/x.rs", _test_fn(body)) == []


def test_a_unix_only_test_or_file_passes():
    line = "let c = \"while [ -f x ]; do sleep 1; done\";"
    assert mod.check_rust("appv3/crates/agent/tests/x.rs", "#[cfg(unix)]\n" + _test_fn(line)) == []
    assert mod.check_rust("appv3/crates/agent/tests/x.rs", "#![cfg(unix)]\n" + _test_fn(line)) == []


def test_a_stated_reason_passes_and_comments_are_not_code():
    exempt = "// posix-only: refused before it runs\n    let j = json!({\"command\": \"echo $KEY\"});"
    assert mod.check_rust("appv3/crates/agent/tests/x.rs", _test_fn(exempt)) == []
    assert mod.check_rust("appv3/crates/agent/tests/x.rs", _test_fn("// `printf 'y' | agentd approve`")) == []


def test_template_references_and_non_test_code_pass():
    template = 'let j = json!({"command": "npx", "env": {"T": "${GITHUB_TOKEN}"}});'
    assert mod.check_rust("appv3/crates/mcp/src/config/tests.rs", _test_fn(template)) == []
    assert mod.check_rust("appv3/crates/tools/src/shell.rs", "fn run() { Command::new(\"sh\"); }\n") == []
    assert mod.check_rust("appv3/crates/tools/src/shell.rs", "#[cfg(test)]\nmod tests {\n" + _test_fn('Command::new("sh");') + "}\n")


def _repo(tmp_path: Path, attributes: str) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / ".gitattributes").write_text(attributes)
    (tmp_path / "list.json").write_text("{}\n")
    (tmp_path / "list.json.sig").write_text("sig\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    return tmp_path


def test_a_signed_file_git_may_rewrite_is_caught(tmp_path):
    # The gallery test failed on Windows because `* text=auto` gave v1.json CRLF.
    root = _repo(tmp_path, "* text=auto\n")
    problems = mod.check_signed(root, mod.tracked_files(root))
    assert sorted(p.split(":")[0] for p in problems) == ["list.json", "list.json.sig"]


def test_a_signed_file_marked_binary_passes(tmp_path):
    root = _repo(tmp_path, "* text=auto\n*.json -text\n*.json.sig -text\n")
    assert mod.check_signed(root, mod.tracked_files(root)) == []


def test_the_repository_passes():
    assert mod.main([]) == 0
