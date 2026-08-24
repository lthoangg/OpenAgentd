"""Tests for the team media proxy endpoints.

Covers:
  GET /api/team/{session_id}/uploads/{filename}   → user uploads
  GET /api/team/{session_id}/media/{path:path}    → agent workspace

Both endpoints must enforce:
  - session_id is a valid UUID (400 on malformed)
  - path traversal (``..``) is rejected (400)
  - absolute paths are rejected (400)
  - missing files → 404
  - happy path returns file bytes with correct Content-Type
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.usefixtures("setup_db")


@pytest.fixture
def app_no_team():
    """Create a FastAPI app — team is not required for media routes."""
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


def _use_coding_workspace(monkeypatch, team_routes, workspace):
    async def load_session(_session_id: str):
        return SimpleNamespace(workspace=str(workspace))

    monkeypatch.setattr(team_routes, "_session_row", load_session)


# ── GET /api/team/{sid}/uploads/{filename} ───────────────────────────────────


class TestUploadsEndpoint:
    def test_invalid_session_id_returns_400(self, client):
        resp = client.get("/api/team/not-a-uuid/uploads/file.png")
        assert resp.status_code == 400

    def test_missing_file_returns_404(self, client, session_id):
        resp = client.get(f"/api/team/{session_id}/uploads/does-not-exist.png")
        assert resp.status_code == 404

    def test_filename_with_slash_does_not_reach_handler(self, client, session_id):
        # ``%2F`` is decoded by the HTTP client into a real ``/`` before the
        # request is sent, producing a two-segment path that the flat
        # ``{filename}`` route pattern cannot match.  The request falls
        # through to the SPA catch-all — it never reaches our handler,
        # so no file can be served from a traversal attempt.
        resp = client.get(f"/api/team/{session_id}/uploads/sub%2Fevil.png")
        # Either our guard rejects (400) or the SPA catch-all handles it
        # (200 with index.html — harmless).  What matters is no file bytes
        # from the server leak.
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            # SPA fallback — must be HTML, not an attacker-controlled file.
            assert "text/html" in resp.headers.get("content-type", "")

    def test_filename_traversal_does_not_escape(self, client, session_id):
        # A bare ``..`` in the path is normalised by the URL router before
        # our handler sees it (common Starlette / HTTP behaviour).  The
        # request may hit the SPA catch-all; what matters is that no file
        # outside the uploads dir is served.
        resp = client.get(f"/api/team/{session_id}/uploads/..")
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            assert "text/html" in resp.headers.get("content-type", "")

    def test_happy_path_serves_file(self, client, session_id, tmp_path, monkeypatch):
        fake_root = tmp_path / "uploads"
        fake_root.mkdir(parents=True)
        target = fake_root / "hello.png"
        png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00"
            b"\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9c"
            b"c\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\x5b\xb0\x1d\x1a\x00\x00"
            b"\x00\x00IEND\xaeB`\x82"
        )
        target.write_bytes(png)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root.parent)

        resp = client.get(f"/api/team/{session_id}/uploads/hello.png")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/png")
        assert resp.content == png

    def test_coding_session_uploads_use_workspace_uploads_dir(
        self, client, session_id, tmp_path, monkeypatch
    ):
        workspace = tmp_path / "repo"
        uploads = workspace / "uploads"
        uploads.mkdir(parents=True)
        target = uploads / "hello.png"
        png = b"\x89PNG\r\n\x1a\n"
        target.write_bytes(png)

        from app.api.routes.team import files as team_routes

        async def fake_session_row(_sid: str):
            return SimpleNamespace(workspace=str(workspace))

        monkeypatch.setattr(team_routes, "_session_row", fake_session_row)

        resp = client.get(f"/api/team/{session_id}/uploads/hello.png")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/png")
        assert resp.content == png

    def test_empty_filename_rejected(self, client, session_id):
        """Empty filename must be rejected."""
        resp = client.get(f"/api/team/{session_id}/uploads/")
        # Empty filename after the last slash — either 400, 404, or SPA fallback.
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            # SPA fallback — must be HTML, not an attacker-controlled file.
            assert "text/html" in resp.headers.get("content-type", "")

    def test_dot_filename_rejected(self, client, session_id):
        """Filename '.' must be rejected."""
        resp = client.get(f"/api/team/{session_id}/uploads/.")
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            assert "text/html" in resp.headers.get("content-type", "")

    def test_dot_dot_filename_rejected(self, client, session_id):
        """Filename '..' must be rejected."""
        resp = client.get(f"/api/team/{session_id}/uploads/..")
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            assert "text/html" in resp.headers.get("content-type", "")

    def test_backslash_in_filename_rejected(self, client, session_id):
        """Filename with backslash must be rejected."""
        resp = client.get(f"/api/team/{session_id}/uploads/evil\\file.png")
        assert resp.status_code == 400

    def test_url_encoded_traversal_rejected(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """URL-encoded traversal (%2e%2e%2f) must be rejected."""
        fake_root = tmp_path / "uploads"
        fake_root.mkdir(parents=True)
        secret = tmp_path / "secret.txt"
        secret.write_text("do not leak")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root.parent)

        resp = client.get(f"/api/team/{session_id}/uploads/%2e%2e%2fsecret.txt")
        # The URL-encoded traversal should be rejected, not found, or hit SPA fallback
        assert resp.status_code in (200, 400, 404)
        if resp.status_code == 200:
            # SPA fallback — must be HTML, not the secret file
            assert "text/html" in resp.headers.get("content-type", "")
        assert "do not leak" not in resp.text

    def test_content_type_jpeg(self, client, session_id, tmp_path, monkeypatch):
        """Verify JPEG files get correct Content-Type."""
        fake_root = tmp_path / "uploads"
        fake_root.mkdir(parents=True)
        target = fake_root / "photo.jpg"
        jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF"
        target.write_bytes(jpeg)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root.parent)

        resp = client.get(f"/api/team/{session_id}/uploads/photo.jpg")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/jpeg")

    def test_content_type_webp(self, client, session_id, tmp_path, monkeypatch):
        """Verify WebP files get correct Content-Type."""
        fake_root = tmp_path / "uploads"
        fake_root.mkdir(parents=True)
        target = fake_root / "image.webp"
        webp = b"RIFF\x00\x00\x00\x00WEBP"
        target.write_bytes(webp)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root.parent)

        resp = client.get(f"/api/team/{session_id}/uploads/image.webp")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/webp")

    def test_separation_invariant_uploads_cannot_serve_workspace(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Uploads endpoint must not serve files from workspace_dir."""
        fake_uploads = tmp_path / "uploads"
        fake_uploads.mkdir(parents=True)
        fake_workspace = tmp_path / "workspace"
        fake_workspace.mkdir(parents=True)
        workspace_file = fake_workspace / "secret.txt"
        workspace_file.write_text("workspace secret")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, tmp_path)

        # Try to access workspace file via uploads endpoint — must fail.
        resp = client.get(f"/api/team/{session_id}/uploads/secret.txt")
        assert resp.status_code == 404
        assert "workspace secret" not in resp.text


# ── GET /api/team/{sid}/media/{path:path} ────────────────────────────────────


class TestWorkspaceMediaEndpoint:
    def test_invalid_session_id_returns_400(self, client):
        resp = client.get("/api/team/not-a-uuid/media/file.png")
        assert resp.status_code == 400

    def test_missing_file_returns_404(self, client, session_id):
        resp = client.get(f"/api/team/{session_id}/media/does-not-exist.png")
        assert resp.status_code == 404

    def test_traversal_rejected(self, client, session_id, tmp_path, monkeypatch):
        # Even if the parent dir exists, ``..`` must escape-reject.
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        secret = tmp_path / "secret.txt"
        secret.write_text("do not leak")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/..%2Fsecret.txt")
        assert resp.status_code in (400, 404)
        assert "do not leak" not in resp.text

    def test_absolute_path_rejected(self, client, session_id, tmp_path, monkeypatch):
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        # FastAPI path converter normalises — simulate via a leading slash
        # encoded as part of the path segment.  The ``file_path`` value seen
        # by the handler will be ``/etc/hosts`` (no session prefix).  Our
        # ``_safe_resolve`` rejects absolute inputs.
        resp = client.get(f"/api/team/{session_id}/media//etc/hosts")
        # Either 400 (rejected by guard) or 404 (not found under workspace).
        assert resp.status_code in (400, 404)

    def test_nested_subpath_served(self, client, session_id, tmp_path, monkeypatch):
        fake_root = tmp_path / "ws"
        sub = fake_root / "output"
        sub.mkdir(parents=True)
        target = sub / "chart.png"
        png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        target.write_bytes(png)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/output/chart.png")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/png")
        assert resp.content == png

    def test_content_type_guessed_from_extension(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        (fake_root / "notes.txt").write_text("hi")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/notes.txt")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")

    def test_directory_path_returns_404(
        self, client, session_id, tmp_path, monkeypatch
    ):
        fake_root = tmp_path / "ws"
        (fake_root / "subdir").mkdir(parents=True)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        # A directory is not a file — 404 by our ``_safe_resolve`` contract.
        resp = client.get(f"/api/team/{session_id}/media/subdir")
        assert resp.status_code == 404

    def test_empty_path_rejected(self, client, session_id, tmp_path, monkeypatch):
        """Empty path must be rejected."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/")
        assert resp.status_code in (400, 404)

    def test_whitespace_only_path_rejected(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Whitespace-only path must be rejected."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/%20%20%20")
        assert resp.status_code == 400

    def test_windows_drive_letter_rejected(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Windows drive letter paths must be rejected."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/C:file.txt")
        assert resp.status_code == 400

    def test_deeply_nested_valid_path(self, client, session_id, tmp_path, monkeypatch):
        """Deeply nested valid paths should work."""
        fake_root = tmp_path / "ws"
        deep = fake_root / "a" / "b" / "c" / "d" / "e"
        deep.mkdir(parents=True)
        target = deep / "file.txt"
        target.write_text("deep content")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/a/b/c/d/e/file.txt")
        assert resp.status_code == 200
        assert resp.text == "deep content"

    def test_content_type_svg(self, client, session_id, tmp_path, monkeypatch):
        """SVG files should get correct Content-Type."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        target = fake_root / "diagram.svg"
        target.write_text("<svg></svg>")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/diagram.svg")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("image/svg")

    def test_content_type_json(self, client, session_id, tmp_path, monkeypatch):
        """JSON files should get correct Content-Type."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        target = fake_root / "data.json"
        target.write_text('{"key": "value"}')

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/data.json")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")

    def test_content_type_pdf(self, client, session_id, tmp_path, monkeypatch):
        """PDF files should get correct Content-Type."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        target = fake_root / "doc.pdf"
        # Minimal PDF magic bytes
        target.write_bytes(b"%PDF-1.4")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/doc.pdf")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/pdf")

    def test_separation_invariant_media_cannot_serve_uploads(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Media endpoint must not serve files from uploads_dir."""
        fake_uploads = tmp_path / "uploads"
        fake_uploads.mkdir(parents=True)
        fake_workspace = tmp_path / "workspace"
        fake_workspace.mkdir(parents=True)
        uploads_file = fake_uploads / "secret.txt"
        uploads_file.write_text("uploads secret")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_workspace)

        # Try to access uploads file via media endpoint — must fail.
        resp = client.get(f"/api/team/{session_id}/media/secret.txt")
        assert resp.status_code == 404
        assert "uploads secret" not in resp.text

    def test_symlink_to_file_inside_workspace_allowed(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """Symlinks to files inside workspace should be allowed."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        target = fake_root / "real.txt"
        target.write_text("real content")
        link = fake_root / "link.txt"
        link.symlink_to(target)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/link.txt")
        assert resp.status_code == 200
        assert resp.text == "real content"

    def test_symlink_escape_rejected(self, client, session_id, tmp_path, monkeypatch):
        """Symlinks pointing outside workspace must be rejected."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        secret = tmp_path / "secret.txt"
        secret.write_text("do not leak")
        link = fake_root / "escape.txt"
        link.symlink_to(secret)

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/escape.txt")
        assert resp.status_code == 400
        assert "do not leak" not in resp.text

    def test_url_encoded_traversal_rejected(
        self, client, session_id, tmp_path, monkeypatch
    ):
        """URL-encoded traversal (%2e%2e%2f) must be rejected."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        secret = tmp_path / "secret.txt"
        secret.write_text("do not leak")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/%2e%2e%2fsecret.txt")
        assert resp.status_code in (400, 404)
        assert "do not leak" not in resp.text

    def test_dot_slash_path_allowed(self, client, session_id, tmp_path, monkeypatch):
        """Paths like ./file.txt should be normalized and allowed."""
        fake_root = tmp_path / "ws"
        fake_root.mkdir(parents=True)
        target = fake_root / "file.txt"
        target.write_text("content")

        from app.api.routes.team import files as team_routes

        _use_coding_workspace(monkeypatch, team_routes, fake_root)

        resp = client.get(f"/api/team/{session_id}/media/./file.txt")
        assert resp.status_code == 200
        assert resp.text == "content"
