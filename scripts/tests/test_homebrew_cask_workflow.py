from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CASK_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "publish-homebrew-cask.yml"


def test_cask_installs_the_notarized_app_unchanged() -> None:
    # CI signs and notarizes the app once (desktop/scripts/sign-macos-release.sh);
    # the in-app updater installs that signature unchanged, so the cask must
    # not replace it, and must not strip quarantine (that skips Gatekeeper).
    workflow = CASK_WORKFLOW.read_text(encoding="utf-8")

    assert "com.apple.quarantine" not in workflow
    assert "postflight" not in workflow
    assert "/usr/bin/codesign" not in workflow
    assert "keychain" not in workflow.lower()
