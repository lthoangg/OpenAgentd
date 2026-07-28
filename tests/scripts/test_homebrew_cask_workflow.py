from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CASK_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "publish-homebrew-cask.yml"


def test_cask_uses_ruby_tmpdir_api() -> None:
    workflow = CASK_WORKFLOW.read_text(encoding="utf-8")

    assert "Dir.mktmpdir" in workflow
    assert "Dir.mktempdir" not in workflow
