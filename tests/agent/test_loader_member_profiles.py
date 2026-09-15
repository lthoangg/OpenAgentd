from __future__ import annotations

from pathlib import Path

from app.agent.loader import (
    clear_member_profiles_cache,
    ensure_builtin_member_agents,
    load_member_profiles,
)


def test_load_member_profiles_default_builtins(tmp_path: Path) -> None:
    profiles = load_member_profiles(tmp_path)
    assert "explorer" in profiles
    assert "researcher" in profiles
    assert profiles["explorer"].role == "member"
    assert "glob" in profiles["explorer"].tools
    assert "read" in profiles["explorer"].tools
    assert "web_search" in profiles["researcher"].tools


def test_ensure_builtin_member_agents_materializes_files(tmp_path: Path) -> None:
    written = ensure_builtin_member_agents(tmp_path)
    assert "explorer.md" in written
    assert "researcher.md" in written

    assert (tmp_path / "explorer.md").exists()
    assert (tmp_path / "researcher.md").exists()

    # Second run does not overwrite
    second_written = ensure_builtin_member_agents(tmp_path)
    assert second_written == []


def test_user_authored_member_profile(tmp_path: Path) -> None:
    custom_file = tmp_path / "custom_reviewer.md"
    custom_file.write_text(
        """---
name: custom_reviewer
role: member
description: Reviews code for performance
tools:
  - read
  - grep
---
You are a custom reviewer. Check for O(N^2) loops.
""",
        encoding="utf-8",
    )

    profiles = load_member_profiles(tmp_path)
    assert "custom_reviewer" in profiles
    assert profiles["custom_reviewer"].description == "Reviews code for performance"
    assert "You are a custom reviewer" in profiles["custom_reviewer"].system_prompt
    assert profiles["custom_reviewer"].tools == ["read", "grep"]


def test_load_member_profiles_defaults_missing_tools_and_prompt(tmp_path: Path) -> None:
    file = tmp_path / "explorer.md"
    file.write_text(
        """---
name: explorer
role: member
description: Explores the codebase
---
""",
        encoding="utf-8",
    )

    profiles = load_member_profiles(tmp_path)
    assert "explorer" in profiles
    assert profiles["explorer"].tools == ["glob", "grep", "read"]
    from app.agent.builtin_prompts import EXPLORER_MEMBER_PROMPT

    assert profiles["explorer"].system_prompt == EXPLORER_MEMBER_PROMPT


def test_member_profiles_caching_and_invalidation(tmp_path: Path) -> None:
    clear_member_profiles_cache()
    custom_file = tmp_path / "fast_analyst.md"
    custom_file.write_text(
        """---
name: fast_analyst
role: member
description: Version 1
tools:
  - read
---
Prompt v1
""",
        encoding="utf-8",
    )

    first = load_member_profiles(tmp_path)
    assert first["fast_analyst"].description == "Version 1"

    # Second call uses cache
    second = load_member_profiles(tmp_path)
    assert second["fast_analyst"].description == "Version 1"
    assert second["fast_analyst"] is first["fast_analyst"]

    # Updating the file invalidates cache via mtime
    import time

    time.sleep(0.01)
    custom_file.write_text(
        """---
name: fast_analyst
role: member
description: Version 2
tools:
  - read
---
Prompt v2
""",
        encoding="utf-8",
    )

    third = load_member_profiles(tmp_path)
    assert third["fast_analyst"].description == "Version 2"

    # Clearing cache forces reload
    clear_member_profiles_cache()
    fourth = load_member_profiles(tmp_path)
    assert fourth["fast_analyst"].description == "Version 2"
