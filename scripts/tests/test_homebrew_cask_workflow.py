from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CASK_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "publish-homebrew-cask.yml"


def test_cask_only_strips_quarantine_and_never_signs() -> None:
    # CI signs the app once (desktop/scripts/sign-macos-release.sh); the
    # in-app updater installs that signature unchanged, so the cask must
    # not replace it with one of its own.
    workflow = CASK_WORKFLOW.read_text(encoding="utf-8")

    assert '"-dr", "com.apple.quarantine"' in workflow
    assert "/usr/bin/codesign" not in workflow
    assert "keychain" not in workflow.lower()
