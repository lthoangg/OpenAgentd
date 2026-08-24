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

from app.models.chat import ChatSession

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


def _use_coding_workspace(monkeypatch, team_routes, root):
    async def load_session(_session_id):
        return ChatSession(workspace=str(root))

    monkeypatch.setattr(team_routes, "_session_row", load_session)


class TestWorkspaceMedia:
    def test_workspace_media_requires_persisted_session_workspace(
        self, client, session_id
    ):
        resp = client.get(f"/api/team/{session_id}/media/secret.txt")

        assert resp.status_code == 404

    def test_workspace_media_defaults_to_inline_for_previews(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "chart.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/chart.png?download=1")
        assert resp.status_code == 200
        assert resp.headers["content-disposition"].startswith("attachment;")


class TestCodingWorkspaceFileRead:
    """GET /api/team/workspace/files/read serves live, frequently-edited
    workspace source files. Without an explicit no-store directive, browsers
    apply heuristic caching (or 304 via a stat-based ETag) and can keep
    serving a version of the file that predates an agent edit — the file
    changes on disk, but reopening it in the coding panel shows stale bytes.
    """

    def test_read_response_disables_caching(self, tmp_path):
        from app.api.app import create_app
        from app.services.team_manager import set_team

        app = create_app()
        set_team(None)
        client = TestClient(app)

        (tmp_path / "app.py").write_text("print('v1')", encoding="utf-8")

        resp = client.get(
            "/api/team/workspace/files/read",
            params={"workspace": str(tmp_path), "path": "app.py"},
        )

        assert resp.status_code == 200
        assert resp.headers.get("cache-control") == "no-store"
        set_team(None)


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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        by_name = {f["name"]: f for f in resp.json()["files"]}
        assert by_name["chart.png"]["mime"].startswith("image/")
        assert by_name["notes.txt"]["mime"].startswith("text/")
        # Unknown extension falls back to the octet-stream default.
        assert by_name["blob.bin"]["mime"] == "application/octet-stream"

    def test_typescript_sources_are_not_reported_as_video(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """``.ts`` is MPEG transport stream in the stdlib MIME table — the
        workspace listing must report TypeScript source instead, otherwise the
        UI previews the file in a <video> player."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "main.ts").write_text("export const a = 1\n")
        (fake_root / "mod.mts").write_text("export const b = 2\n")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        by_name = {f["name"]: f for f in resp.json()["files"]}
        assert by_name["main.ts"]["mime"] == "text/typescript"
        assert by_name["mod.mts"]["mime"] == "text/typescript"

    def test_media_serves_typescript_as_text(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "main.ts").write_text("export const a = 1\n")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/main.ts")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/typescript")

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

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

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/files")
        body = resp.json()
        assert body["truncated"] is True
        assert len(body["files"]) == cap


class TestGitBackedListing:
    """A git work tree is listed through git itself, not the naive matcher.

    The hand-rolled ``.gitignore`` matcher used for non-git workspaces only
    reads the *root* ``.gitignore`` and matches with ``fnmatch``, whose ``*``
    crosses ``/``. That silently hid files the user can plainly see in their
    editor — and they went missing from *both* the ``@``-mention picker and the
    command palette, which share this listing. When the workspace is the top
    level of a git work tree, ``git ls-files`` is the source of truth.
    """

    @staticmethod
    def _init_repo(root: Path) -> None:
        import subprocess

        root.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "init", "-q", "."], cwd=root, check=True, capture_output=True
        )

    @staticmethod
    def _commit_all(root: Path) -> None:
        import subprocess

        subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "init",
            ],
            cwd=root,
            check=True,
            capture_output=True,
        )

    def test_nested_paths_under_single_level_ignore_pattern_are_listed(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """``docs/*.tmp`` ignores one level only — git shows deeper matches.

        The fnmatch matcher treated ``*`` as crossing ``/``, so
        ``docs/guide/deep/notes.tmp`` disappeared even though ``git status``
        lists it.
        """
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        (fake_root / ".gitignore").write_text("docs/*.tmp\n", encoding="utf-8")
        deep = fake_root / "docs" / "guide" / "deep"
        deep.mkdir(parents=True)
        (deep / "notes.tmp").write_text("keep me")
        (fake_root / "docs" / "scratch.tmp").write_text("ignored")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert "docs/guide/deep/notes.tmp" in paths
        assert "docs/scratch.tmp" not in paths

    def test_tracked_build_and_dist_files_are_listed(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """``build/`` and ``dist/`` are only noise when git says so.

        They were pruned unconditionally by the agent tools' skip list, so a
        tracked ``build/Dockerfile`` or a committed ``dist/`` bundle could
        never be tagged or opened from the palette.
        """
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        (fake_root / "build").mkdir()
        (fake_root / "build" / "Dockerfile").write_text("FROM scratch\n")
        (fake_root / "dist" / "assets").mkdir(parents=True)
        (fake_root / "dist" / "assets" / "logo.svg").write_text("<svg/>")
        (fake_root / "main.py").write_text("x = 1\n")
        self._commit_all(fake_root)

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert paths == ["build/Dockerfile", "dist/assets/logo.svg", "main.py"]

    def test_nested_gitignore_files_are_honoured(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Only the root ``.gitignore`` was ever read; git honours all of them."""
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        pkg = fake_root / "pkg"
        pkg.mkdir()
        (pkg / ".gitignore").write_text("secret.txt\n", encoding="utf-8")
        (pkg / "secret.txt").write_text("hide")
        (pkg / "app.py").write_text("ok")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert "pkg/app.py" in paths
        assert "pkg/secret.txt" not in paths

    def test_untracked_dependency_dirs_are_still_skipped(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """A repo that forgot to ignore ``node_modules`` must not flood the
        picker (and burn the file cap) with dependency files."""
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        (fake_root / "node_modules" / "pkg").mkdir(parents=True)
        (fake_root / "node_modules" / "pkg" / "index.js").write_text("x")
        (fake_root / "app.js").write_text("x")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert paths == ["app.js"]

    def test_workspace_nested_inside_an_ignored_repo_dir_falls_back_to_walk(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Session workspaces live under a gitignored ``.openagentd/`` dir of
        the *host* repo. ``git ls-files`` there returns nothing, so the git
        path must only apply when the workspace is the work tree's top level.
        """
        from app.api.routes.team import files as team_routes

        repo = tmp_path / "host-repo"
        self._init_repo(repo)
        (repo / ".gitignore").write_text(".openagentd/\n", encoding="utf-8")
        fake_root = repo / ".openagentd" / "workspace" / "sess"
        fake_root.mkdir(parents=True)
        (fake_root / "report.md").write_text("# hi")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert paths == ["report.md"]

    def test_submodule_contents_are_listed(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """``git ls-files`` reports a submodule as one gitlink entry; its files
        must still be reachable from the picker."""
        import subprocess

        from app.api.routes.team import files as team_routes

        dep = tmp_path / "dep"
        self._init_repo(dep)
        (dep / "lib.py").write_text("lib")
        self._commit_all(dep)

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        (fake_root / "main.py").write_text("main")
        self._commit_all(fake_root)
        added = subprocess.run(
            [
                "git",
                "-c",
                "protocol.file.allow=always",
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "submodule",
                "add",
                "-q",
                str(dep),
                "vendor/dep",
            ],
            cwd=fake_root,
            capture_output=True,
        )
        if added.returncode != 0:
            pytest.skip("submodule creation unsupported in this environment")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert "vendor/dep/lib.py" in paths
        assert "main.py" in paths

    def test_cap_truncates_git_listing(self, client, session_id, tmp_path, monkeypatch):
        """The cap applies to the git path too, and only flips ``truncated``
        when entries were genuinely left out."""
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        self._init_repo(fake_root)
        for i in range(6):
            (fake_root / f"f{i}.txt").write_text("x")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        monkeypatch.setattr(team_routes, "_MAX_FILES_LISTED", 4)
        body = client.get(f"/api/team/{session_id}/files").json()
        assert body["truncated"] is True
        assert len(body["files"]) == 4

        monkeypatch.setattr(team_routes, "_MAX_FILES_LISTED", 6)
        body = client.get(f"/api/team/{session_id}/files").json()
        assert body["truncated"] is False
        assert len(body["files"]) == 6

    def test_non_git_workspace_lists_generated_output_dirs(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Agent session workspaces are not repos: a site the agent built into
        ``dist/`` is real user content and must be listable, while dependency
        and cache dirs stay hidden."""
        from app.api.routes.team import files as team_routes

        fake_root = tmp_path / "ws"
        fake_root.mkdir()
        (fake_root / "dist").mkdir()
        (fake_root / "dist" / "index.html").write_text("<html/>")
        (fake_root / "build").mkdir()
        (fake_root / "build" / "bundle.js").write_text("x")
        (fake_root / "node_modules" / "pkg").mkdir(parents=True)
        (fake_root / "node_modules" / "pkg" / "index.js").write_text("x")
        (fake_root / "__pycache__").mkdir()
        (fake_root / "__pycache__" / "m.pyc").write_bytes(b"\x00")
        (fake_root / "app.py").write_text("x")

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        paths = sorted(
            f["path"]
            for f in client.get(f"/api/team/{session_id}/files").json()["files"]
        )
        assert paths == ["app.py", "build/bundle.js", "dist/index.html"]


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
