"""Tests for the team workspace-files listing endpoint.

Covers:
  GET /api/team/{session_id}/files    → recursive listing of agent workspace

Requirements validated:
  - session_id validated as UUID (400 on malformed)
  - Missing workspace dir returns an empty list (not 404) — fresh session
  - Nested files are surfaced with POSIX-separated relative paths
  - Dotfiles/dot-dirs are excluded
  - MIME types are guessed from the extension
  - Symlinks escaping the workspace root are skipped
  - Truncation flag flips when the file cap is exceeded
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.usefixtures("setup_db")


@pytest.fixture
def app_no_team():
    from app.api.app import create_app
    from app.services.team_manager import set_team

    app = create_app()
    set_team(None)
    yield app
    set_team(None)


@pytest.fixture
def client(app_no_team):
    return TestClient(app_no_team)


@pytest.fixture
def session_id() -> str:
    return str(uuid.uuid7())


class TestWorkspaceMedia:
    def test_workspace_media_defaults_to_inline_for_previews(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/media/chart.png")
        assert resp.status_code == 200
        assert resp.headers["content-disposition"].startswith("inline;")

    def test_workspace_media_can_force_attachment_download(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/media/chart.png?download=1")
        assert resp.status_code == 200
        assert resp.headers["content-disposition"].startswith("attachment;")


class TestWorkspaceFilesListing:
    def test_invalid_session_id_returns_400(self, client):
        resp = client.get("/api/team/not-a-uuid/files")
        assert resp.status_code == 400

    def test_missing_workspace_returns_empty_list(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Fresh session: workspace dir doesn't exist yet — endpoint returns []
        rather than 404.  The UI needs a stable contract to render an empty
        state."""
        fake_root = tmp_path / "does-not-exist"

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == session_id
        assert body["files"] == []
        assert body["truncated"] is False

    def test_lists_flat_files(self, client, session_id, tmp_path, monkeypatch):
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        (fake_root / "notes.txt").write_text("hi")
        (fake_root / "readme.md").write_text("# hello")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        assert resp.status_code == 200
        body = resp.json()
        paths = sorted(f["path"] for f in body["files"])
        assert paths == ["notes.txt", "readme.md"]
        # Each entry has the expected shape.
        for entry in body["files"]:
            assert entry["name"]
            assert entry["size"] >= 0
            assert isinstance(entry["mtime"], float)
            assert entry["mime"]

    def test_lists_nested_files_with_posix_paths(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        (fake_root / "output").mkdir(parents=True)
        (fake_root / "output" / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (fake_root / "output" / "nested").mkdir()
        (fake_root / "output" / "nested" / "data.json").write_text("{}")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        assert resp.status_code == 200
        paths = sorted(f["path"] for f in resp.json()["files"])
        # POSIX separators — safe to concat into ``/media/{path}``.
        assert paths == ["output/chart.png", "output/nested/data.json"]

    def test_mime_guessed_from_extension(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (fake_root / "notes.txt").write_text("hi")
        (fake_root / "blob.bin").write_bytes(b"\x00\x01\x02")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        by_name = {f["name"]: f for f in resp.json()["files"]}
        assert by_name["chart.png"]["mime"].startswith("image/")
        assert by_name["notes.txt"]["mime"].startswith("text/")
        # Unknown extension falls back to the octet-stream default.
        assert by_name["blob.bin"]["mime"] == "application/octet-stream"

    def test_generated_dirs_excluded_other_dotentries_allowed(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """VCS/generated cache dirs are always pruned, but other dot-prefixed
        files and folders flow through so the InputBar @-mention picker can tag
        things like ``.openagentd/`` skills, ``.github/`` workflows, or
        ``.env.example``. Filtering beyond common generated dirs is delegated to
        ``.gitignore``."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "visible.txt").write_text("ok")
        (fake_root / ".env.example").write_text("KEY=")
        (fake_root / ".git").mkdir()
        (fake_root / ".git" / "HEAD").write_text("ref: …")
        (fake_root / ".ruff_cache").mkdir()
        (fake_root / ".ruff_cache" / "cache").write_text("x")
        (fake_root / ".pytest_cache").mkdir()
        (fake_root / ".pytest_cache" / "cache").write_text("x")
        (fake_root / ".github").mkdir()
        (fake_root / ".github" / "ci.yml").write_text("jobs: {}")
        (fake_root / "sub").mkdir()
        (fake_root / "sub" / ".swp").write_text("tmp")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        paths = sorted(f["path"] for f in resp.json()["files"])
        assert paths == [
            ".env.example",
            ".github/ci.yml",
            "sub/.swp",
            "visible.txt",
        ]
        assert not any(p.startswith(".git/") for p in paths)
        assert not any(p.startswith(".ruff_cache/") for p in paths)
        assert not any(p.startswith(".pytest_cache/") for p in paths)

    def test_gitignore_negation_reincludes_dot_subdir(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """``.gitignore`` with ``.openagentd/*`` + ``!.openagentd/skills/``
        should hide the ignored siblings but surface the re-included subtree
        so users can @-mention their tracked skill files."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / ".gitignore").write_text(
            ".openagentd/*\n!.openagentd/skills/\n",
            encoding="utf-8",
        )
        oad = fake_root / ".openagentd"
        oad.mkdir()
        (oad / "data").mkdir()
        (oad / "data" / "runtime.db").write_text("x")
        (oad / "skills").mkdir()
        (oad / "skills" / "SKILL.md").write_text("# skill")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        paths = sorted(f["path"] for f in resp.json()["files"])
        assert ".openagentd/skills/SKILL.md" in paths
        assert ".openagentd/data/runtime.db" not in paths

    def test_regular_files_are_not_resolved_individually(self, tmp_path, monkeypatch):
        """The listing resolves each walked directory, not every regular file."""
        from app.api.routes.team import files as team_routes

        root = tmp_path / "ws"
        nested = root / "nested"
        nested.mkdir(parents=True)
        file_count = 12
        for index in range(file_count):
            parent = root if index % 2 == 0 else nested
            (parent / f"file-{index}.txt").write_text("x")

        resolve_calls: list[Path] = []
        lstat_calls: list[Path] = []
        original_resolve = Path.resolve
        original_lstat = Path.lstat

        def count_resolve(path: Path, *, strict: bool = False) -> Path:
            resolve_calls.append(path)
            return original_resolve(path, strict=strict)

        def count_lstat(path: Path):
            lstat_calls.append(path)
            return original_lstat(path)

        monkeypatch.setattr(Path, "resolve", count_resolve)
        monkeypatch.setattr(Path, "lstat", count_lstat)

        listing = team_routes._list_workspace_files(root, "session")

        assert len(listing.files) == file_count
        assert len(resolve_calls) == 2  # root plus its one walked subdirectory
        assert sum(path.parent in (root, nested) for path in lstat_calls) == file_count

    def test_symlink_escaping_root_is_skipped(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """A symlink inside the workspace that points outside must not leak
        the external file's metadata into the listing."""
        outside = tmp_path / "outside"
        outside.mkdir()
        secret = outside / "secret.txt"
        secret.write_text("top-secret")

        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "visible.txt").write_text("ok")
        internal = fake_root / "internal.txt"
        internal.write_text("safe")
        # Create symlinks inside the workspace. On platforms that don't allow
        # symlinks (rare), skip cleanly.
        try:
            (fake_root / "inside-link.txt").symlink_to(internal)
            (fake_root / "escape.txt").symlink_to(secret)
        except (OSError, NotImplementedError):
            pytest.skip("symlink creation not supported on this platform")

        from app.api.routes.team import files as team_routes

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        paths = [f["path"] for f in resp.json()["files"]]
        assert "escape.txt" not in paths
        assert "inside-link.txt" in paths
        assert "visible.txt" in paths

    def test_truncation_when_over_cap(self, client, session_id, tmp_path, monkeypatch):
        """Beyond ``_MAX_FILES_LISTED`` the walk stops and ``truncated`` flips
        — a defensive ceiling so a pathological workspace can't blow up the
        response."""
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        # Generate one more file than the cap so truncation kicks in.
        cap = team_routes._MAX_FILES_LISTED
        for i in range(cap + 5):
            (fake_root / f"f{i:04d}.txt").write_text("x")

        monkeypatch.setattr(team_routes, "workspace_dir", lambda sid: fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        body = resp.json()
        assert body["truncated"] is True
        assert len(body["files"]) == cap

    # NB: The previous mtime-based "revert boundary" filter is gone. After
    # the move to the Git snapshot service (see app/services/snapshot_service.py),
    # the workspace filesystem is authoritative — restoring a snapshot
    # physically removes files added after that point, so the listing
    # and media endpoints simply report what's on disk. The snapshot
    # round-trip is covered by tests/services/test_snapshot_service.py.


class TestCodingWorkspaceGit:
    def test_workspace_git_history_not_git_repo(self, client, tmp_path, monkeypatch):
        fake_root = tmp_path / "not-git"
        fake_root.mkdir()

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.get(f"/api/team/workspace/git/history?workspace={fake_root}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_git_repo"] is False
        assert body["commits"] == []
        assert body["graph"] == ""

    def test_workspace_git_history_success(self, client, tmp_path, monkeypatch):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        # Initialize real git repo
        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        # Configure git user (required to commit)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        # Create a commit
        file_path = fake_root / "hello.txt"
        file_path.write_text("hello world\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"], cwd=fake_root, check=True
        )

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.get(f"/api/team/workspace/git/history?workspace={fake_root}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["is_git_repo"] is True
        assert len(body["commits"]) == 1
        commit = body["commits"][0]
        assert commit["subject"] == "Initial commit"
        assert commit["author_name"] == "Test User"
        assert commit["author_email"] == "test@example.com"
        assert len(commit["sha"]) == 40
        assert len(commit["short_sha"]) == 7
        assert commit["timestamp"] > 0
        assert "Initial commit" in body["graph"]

    def test_workspace_git_history_all_branches_excludes_stash(
        self, client, tmp_path, monkeypatch
    ):
        """``all=true`` must not surface stash entries as commits."""
        import subprocess

        fake_root = tmp_path / "git-stash-repo"
        fake_root.mkdir()

        def git(*args):
            subprocess.run(
                ["git", *args], cwd=fake_root, check=True, capture_output=True
            )

        git("init")
        git("config", "user.name", "Test User")
        git("config", "user.email", "test@example.com")
        file_path = fake_root / "hello.txt"
        file_path.write_text("hello world\n")
        git("add", "hello.txt")
        git("commit", "-m", "Initial commit")
        # Create a stash entry (refs/stash) — reachable via ``git log --all``.
        file_path.write_text("dirty\n")
        git("stash")

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.get(
            f"/api/team/workspace/git/history?workspace={fake_root}&all=true"
        )
        assert resp.status_code == 200
        body = resp.json()
        subjects = [c["subject"] for c in body["commits"]]
        assert subjects == ["Initial commit"]
        assert "WIP on" not in body["graph"]
        assert "index on" not in body["graph"]

    def test_workspace_git_commit_diff_invalid_sha(self, client, tmp_path, monkeypatch):
        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.get(
            f"/api/team/workspace/git/commit-diff?workspace={fake_root}&sha=invalid_sha_123"
        )
        assert resp.status_code == 422

    def test_workspace_git_commit_diff_success(self, client, tmp_path, monkeypatch):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        file_path = fake_root / "hello.txt"
        file_path.write_text("hello world\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"], cwd=fake_root, check=True
        )

        # Get the commit sha
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        sha = res.stdout.strip()

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.get(
            f"/api/team/workspace/git/commit-diff?workspace={fake_root}&sha={sha}"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["sha"] == sha
        assert "+hello world" in body["diff"]

    def test_workspace_git_undo_success_multi_commit(
        self, client, tmp_path, monkeypatch
    ):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        # Commit 1
        file_path = fake_root / "hello.txt"
        file_path.write_text("hello world 1\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "First commit"], cwd=fake_root, check=True
        )

        # Commit 2
        file_path.write_text("hello world 2\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Second commit"], cwd=fake_root, check=True
        )

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.post(
            "/api/team/workspace/git/undo",
            json={"workspace": str(fake_root)},
        )
        assert resp.status_code == 200
        assert resp.json() == {"workspace": str(fake_root), "success": True}

        # Verify HEAD is now First commit
        res = subprocess.run(
            ["git", "log", "-1", "--format=%s"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        assert res.stdout.strip() == "First commit"

        # Verify changes from Second commit are still in index/working tree
        assert file_path.read_text() == "hello world 2\n"

    def test_workspace_git_undo_success_single_commit(
        self, client, tmp_path, monkeypatch
    ):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        # Only 1 commit
        file_path = fake_root / "hello.txt"
        file_path.write_text("hello world\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Initial commit"], cwd=fake_root, check=True
        )

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.post(
            "/api/team/workspace/git/undo",
            json={"workspace": str(fake_root)},
        )
        assert resp.status_code == 200
        assert resp.json() == {"workspace": str(fake_root), "success": True}

        # Verify HEAD has been deleted (no commits exist)
        res = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=fake_root,
            capture_output=True,
            text=True,
        )
        assert res.returncode != 0

        # Verify hello.txt still exists with changes
        assert file_path.read_text() == "hello world\n"

    def test_workspace_git_undo_failure_no_commits(self, client, tmp_path, monkeypatch):
        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        import subprocess

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.post(
            "/api/team/workspace/git/undo",
            json={"workspace": str(fake_root)},
        )
        assert resp.status_code == 400
        assert "No commits to undo" in resp.json()["detail"]

    def test_workspace_git_revert_success(self, client, tmp_path, monkeypatch):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        # Commit 1
        file_path = fake_root / "hello.txt"
        file_path.write_text("line 1\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "First commit"], cwd=fake_root, check=True
        )

        # Commit 2
        file_path.write_text("line 1\nline 2\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Second commit"], cwd=fake_root, check=True
        )

        # Get Commit 2 SHA
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        sha = res.stdout.strip()

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.post(
            "/api/team/workspace/git/revert",
            json={"workspace": str(fake_root), "sha": sha},
        )
        assert resp.status_code == 200
        assert resp.json() == {"workspace": str(fake_root), "sha": sha, "success": True}

        # Verify HEAD is now a revert commit
        res = subprocess.run(
            ["git", "log", "-1", "--format=%s"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        assert res.stdout.strip().startswith("Revert")

        # Verify file content is reverted
        assert file_path.read_text() == "line 1\n"

    def test_workspace_git_revert_conflict_aborted(self, client, tmp_path, monkeypatch):
        import subprocess

        fake_root = tmp_path / "git-repo"
        fake_root.mkdir()

        subprocess.run(["git", "init"], cwd=fake_root, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test User"], cwd=fake_root, check=True
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=fake_root,
            check=True,
        )

        # Commit 1
        file_path = fake_root / "hello.txt"
        file_path.write_text("original\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "First commit"], cwd=fake_root, check=True
        )

        # Commit 2
        file_path.write_text("change A\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Second commit"], cwd=fake_root, check=True
        )

        # Get Commit 2 SHA
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        sha = res.stdout.strip()

        # Commit 3 (modifies same line, will conflict with revert of Commit 2)
        file_path.write_text("change B\n")
        subprocess.run(["git", "add", "hello.txt"], cwd=fake_root, check=True)
        subprocess.run(
            ["git", "commit", "-m", "Third commit"], cwd=fake_root, check=True
        )

        from app.services import team_manager

        monkeypatch.setattr(
            team_manager, "validate_workspace", lambda w: str(fake_root)
        )

        resp = client.post(
            "/api/team/workspace/git/revert",
            json={"workspace": str(fake_root), "sha": sha},
        )
        assert resp.status_code == 400
        assert "Revert failed" in resp.json()["detail"]

        # Verify revert was aborted (no revert in progress, working tree clean or matches Commit 3)
        res = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=fake_root,
            check=True,
            capture_output=True,
            text=True,
        )
        assert res.stdout.strip() == ""
        assert file_path.read_text() == "change B\n"
