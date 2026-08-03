"""Tests for openagentd export / import CLI commands.

Covers:
- export_config: manifest, archive structure, secret redaction, --include-secrets
- import_config: fill-in-gaps merge, --force overwrite, path-traversal guard,
  invalid archive rejection, round-trip fidelity
- _redact_env: all real settings.py secret keys, non-secret vars, comments,
  blank-value lines, blank lines
- import safety: symlinks silently ignored, dirs-only archive rejected,
  file-missing error, str-prefix path attack blocked
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from app.cli.commands.export import export_config, ExportResult
from app.cli.commands.importcmd import import_config, ImportResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_config_dir(tmp_path: Path) -> Path:
    """Build a minimal but realistic config directory."""
    cfg = tmp_path / "config"

    # agents
    (cfg / "agents").mkdir(parents=True)
    (cfg / "agents" / "lead.md").write_text(
        "---\nname: lead\nrole: lead\nmodel: openai:gpt-4\n---\n\nLead agent.",
        encoding="utf-8",
    )
    (cfg / "agents" / "coding").mkdir()
    (cfg / "agents" / "coding" / "coder.md").write_text(
        "---\nname: coder\nrole: member\nmodel: openai:gpt-4\n---\n\nCoder agent.",
        encoding="utf-8",
    )

    # skills
    (cfg / "skills" / "my-skill").mkdir(parents=True)
    (cfg / "skills" / "my-skill" / "SKILL.md").write_text(
        "# My skill\n\nDo things.", encoding="utf-8"
    )

    # commands
    (cfg / "commands").mkdir()
    (cfg / "commands" / "commit.md").write_text(
        '---\ndescription: Commit changes\n---\n\ngit commit -m "$ARGUMENTS"',
        encoding="utf-8",
    )

    # plugins
    (cfg / "plugins").mkdir()
    (cfg / "plugins" / "my_plugin.py").write_text("# custom plugin\n", encoding="utf-8")
    # __pycache__ should be excluded
    (cfg / "plugins" / "__pycache__").mkdir()
    (cfg / "plugins" / "__pycache__" / "my_plugin.cpython-314.pyc").write_bytes(b"\x00")

    # top-level config files
    (cfg / "mcp.json").write_text('{"mcpServers": {}}', encoding="utf-8")
    (cfg / "settings.yaml").write_text(
        "summarization:\n  prompt_token_threshold: 12000\n", encoding="utf-8"
    )
    (cfg / "server.yaml").write_text(
        "host: 0.0.0.0\nport: 4082\naccess_key: lan-secret\n",
        encoding="utf-8",
    )
    (cfg / "multimodal.yaml").write_text(
        "image:\n  model: googlegenai:x\n", encoding="utf-8"
    )

    # .env with secrets
    (cfg / ".env").write_text(
        "APP_ENV=production\nOPENAI_API_KEY=sk-super-secret\nANTHROPIC_API_KEY=ant-key\n",
        encoding="utf-8",
    )

    # .skill-lock.json — should be excluded
    (cfg / ".skill-lock.json").write_text('{"version":1}', encoding="utf-8")

    return cfg


# ---------------------------------------------------------------------------
# export_config tests
# ---------------------------------------------------------------------------


class TestExportConfig:
    def test_creates_archive(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        assert isinstance(result, ExportResult)
        assert result.archive_path.exists()
        assert result.archive_path.suffix == ".gz"
        assert "openagentd-export-" in result.archive_path.name

    def test_archive_has_root_prefix(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert all(n.startswith("openagentd-export/") for n in names)

    def test_agents_included(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/agents/lead.md" in names
        assert "openagentd-export/agents/coding/coder.md" in names

    def test_skills_included(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/skills/my-skill/SKILL.md" in names

    def test_commands_included(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/commands/commit.md" in names

    def test_plugins_included_without_pycache(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/plugins/my_plugin.py" in names
        assert not any("__pycache__" in n for n in names)

    def test_config_files_included(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/mcp.json" in names
        assert "openagentd-export/settings.yaml" in names
        assert "openagentd-export/server.yaml" in names
        assert "openagentd-export/multimodal.yaml" in names

    def test_skill_lock_excluded(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert not any(".skill-lock" in n for n in names)

    def test_env_secrets_redacted_by_default(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            member = tf.getmember("openagentd-export/.env")
            f = tf.extractfile(member)
            assert f is not None
            env_content = f.read().decode("utf-8")
        # Secret keys must be blanked
        assert "sk-super-secret" not in env_content
        assert "ant-key" not in env_content
        # Non-secret lines preserved
        assert "APP_ENV=production" in env_content
        # Keys present but with empty value
        assert "OPENAI_API_KEY=" in env_content
        assert "ANTHROPIC_API_KEY=" in env_content

    def test_env_secrets_preserved_with_include_secrets(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out, include_secrets=True)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            member = tf.getmember("openagentd-export/.env")
            f = tf.extractfile(member)
            assert f is not None
            env_content = f.read().decode("utf-8")
        assert "sk-super-secret" in env_content
        assert "ant-key" in env_content

    def test_server_access_key_redacted_by_default(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()

        result = export_config(cfg, output_dir=out)

        with tarfile.open(result.archive_path, "r:gz") as tf:
            member = tf.getmember("openagentd-export/server.yaml")
            f = tf.extractfile(member)
            assert f is not None
            server_content = f.read().decode("utf-8")
        assert "lan-secret" not in server_content
        assert "host: 0.0.0.0" in server_content
        assert "port: 4082" in server_content

    def test_server_access_key_preserved_with_include_secrets(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()

        result = export_config(cfg, output_dir=out, include_secrets=True)

        with tarfile.open(result.archive_path, "r:gz") as tf:
            member = tf.getmember("openagentd-export/server.yaml")
            f = tf.extractfile(member)
            assert f is not None
            server_content = f.read().decode("utf-8")
        assert "access_key: lan-secret" in server_content

    def test_env_not_included_when_absent(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        (cfg / ".env").unlink()
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        with tarfile.open(result.archive_path, "r:gz") as tf:
            names = tf.getnames()
        assert "openagentd-export/.env" not in names

    def test_result_manifest_lists_packed_files(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        assert len(result.files_packed) > 0
        # Check a few expected entries
        packed = set(result.files_packed)
        assert "agents/lead.md" in packed
        assert "skills/my-skill/SKILL.md" in packed
        assert "mcp.json" in packed
        assert ".env" in packed

    def test_output_path_override(self, tmp_path: Path):
        cfg = _make_config_dir(tmp_path)
        target = tmp_path / "my-export.tar.gz"
        result = export_config(cfg, output_path=target)
        assert result.archive_path == target
        assert target.exists()

    def test_empty_dirs_are_skipped_gracefully(self, tmp_path: Path):
        """Export should not fail if optional dirs (commands, plugins) are absent."""
        cfg = tmp_path / "config"
        (cfg / "agents").mkdir(parents=True)
        (cfg / "agents" / "lead.md").write_text(
            "---\nname: lead\nrole: lead\nmodel: openai:gpt-4\n---\n\nAgent.",
            encoding="utf-8",
        )
        out = tmp_path / "out"
        out.mkdir()
        result = export_config(cfg, output_dir=out)
        assert result.archive_path.exists()


# ---------------------------------------------------------------------------
# import_config tests
# ---------------------------------------------------------------------------


class TestImportConfig:
    def _make_archive(
        self,
        tmp_path: Path,
        *,
        include_secrets: bool = True,
        extra_files: dict[str, str] | None = None,
    ) -> Path:
        """Build and export a config, return the archive path."""
        cfg = _make_config_dir(tmp_path / "src")
        out = tmp_path / "export-out"
        out.mkdir()
        result = export_config(cfg, output_dir=out, include_secrets=include_secrets)
        return result.archive_path

    def test_import_fills_empty_config_dir(self, tmp_path: Path):
        archive = self._make_archive(tmp_path)
        dest = tmp_path / "dest-config"
        dest.mkdir()
        result = import_config(archive, config_dir=dest)
        assert isinstance(result, ImportResult)
        assert (dest / "agents" / "lead.md").exists()
        assert (dest / "skills" / "my-skill" / "SKILL.md").exists()
        assert (dest / "mcp.json").exists()
        assert (dest / "settings.yaml").exists()
        assert (dest / ".env").exists()

    def test_import_merge_does_not_overwrite_existing(self, tmp_path: Path):
        archive = self._make_archive(tmp_path)
        dest = tmp_path / "dest-config"
        (dest / "agents").mkdir(parents=True)
        (dest / "agents" / "lead.md").write_text("existing content", encoding="utf-8")
        import_config(archive, config_dir=dest)
        # Existing file must be untouched
        assert (dest / "agents" / "lead.md").read_text(
            encoding="utf-8"
        ) == "existing content"

    def test_import_force_overwrites_existing(self, tmp_path: Path):
        archive = self._make_archive(tmp_path)
        dest = tmp_path / "dest-config"
        (dest / "agents").mkdir(parents=True)
        (dest / "agents" / "lead.md").write_text("existing content", encoding="utf-8")
        import_config(archive, config_dir=dest, force=True)
        content = (dest / "agents" / "lead.md").read_text(encoding="utf-8")
        assert "existing content" not in content
        assert "lead" in content  # from the agent frontmatter

    def test_import_result_manifest(self, tmp_path: Path):
        archive = self._make_archive(tmp_path)
        dest = tmp_path / "dest-config"
        dest.mkdir()
        result = import_config(archive, config_dir=dest)
        assert len(result.files_written) > 0
        assert len(result.files_skipped) == 0

    def test_import_skipped_files_reported(self, tmp_path: Path):
        archive = self._make_archive(tmp_path)
        dest = tmp_path / "dest-config"
        (dest / "agents").mkdir(parents=True)
        (dest / "agents" / "lead.md").write_text("mine", encoding="utf-8")
        result = import_config(archive, config_dir=dest)
        assert "agents/lead.md" in result.files_skipped

    def test_import_rejects_non_tar_gz(self, tmp_path: Path):
        bad = tmp_path / "not-an-archive.txt"
        bad.write_text("garbage", encoding="utf-8")
        dest = tmp_path / "dest-config"
        dest.mkdir()
        with pytest.raises(ValueError, match="not a valid"):
            import_config(bad, config_dir=dest)

    def test_import_rejects_archive_without_expected_prefix(self, tmp_path: Path):
        """An archive whose entries don't start with openagentd-export/ is rejected."""
        bad_archive = tmp_path / "bad.tar.gz"
        with tarfile.open(bad_archive, "w:gz") as tf:
            content = b"hello"
            info = tarfile.TarInfo(name="some-other-dir/file.txt")
            info.size = len(content)
            tf.addfile(info, io.BytesIO(content))
        dest = tmp_path / "dest-config"
        dest.mkdir()
        with pytest.raises(ValueError, match="not a valid openagentd export"):
            import_config(bad_archive, config_dir=dest)

    def test_import_blocks_path_traversal(self, tmp_path: Path):
        """Archive entries with .. in paths must be rejected."""
        evil_archive = tmp_path / "evil.tar.gz"
        with tarfile.open(evil_archive, "w:gz") as tf:
            content = b"evil"
            info = tarfile.TarInfo(name="openagentd-export/../../../etc/passwd")
            info.size = len(content)
            tf.addfile(info, io.BytesIO(content))
        dest = tmp_path / "dest-config"
        dest.mkdir()
        with pytest.raises(ValueError, match="path traversal"):
            import_config(evil_archive, config_dir=dest)

    def test_round_trip_preserves_content(self, tmp_path: Path):
        """Export → import produces identical file content."""
        cfg = _make_config_dir(tmp_path / "src")
        out = tmp_path / "export-out"
        out.mkdir()
        result = export_config(cfg, output_dir=out, include_secrets=True)

        dest = tmp_path / "dest"
        dest.mkdir()
        import_config(result.archive_path, config_dir=dest)

        # Check a non-.env file
        src_content = (cfg / "agents" / "lead.md").read_text(encoding="utf-8")
        dst_content = (dest / "agents" / "lead.md").read_text(encoding="utf-8")
        assert src_content == dst_content

        # Check mcp.json
        assert (dest / "mcp.json").read_text(encoding="utf-8") == (
            cfg / "mcp.json"
        ).read_text(encoding="utf-8")

    def test_round_trip_redacted_env_preserved(self, tmp_path: Path):
        """After export with redaction, the .env is imported with blanked secrets."""
        cfg = _make_config_dir(tmp_path / "src")
        out = tmp_path / "export-out"
        out.mkdir()
        result = export_config(cfg, output_dir=out, include_secrets=False)

        dest = tmp_path / "dest"
        dest.mkdir()
        import_config(result.archive_path, config_dir=dest)

        env = (dest / ".env").read_text(encoding="utf-8")
        assert "sk-super-secret" not in env
        assert "APP_ENV=production" in env

    def test_import_rejects_missing_file(self, tmp_path: Path):
        """Passing a non-existent path raises ValueError, not FileNotFoundError."""
        dest = tmp_path / "dest"
        dest.mkdir()
        with pytest.raises(ValueError, match="not a valid"):
            import_config(tmp_path / "ghost.tar.gz", config_dir=dest)

    def test_import_dirs_only_archive_rejected(self, tmp_path: Path):
        """An archive with only directory entries and no files is rejected."""
        arch = tmp_path / "dirs-only.tar.gz"
        with tarfile.open(arch, "w:gz") as tf:
            info = tarfile.TarInfo(name="openagentd-export/agents")
            info.type = tarfile.DIRTYPE
            tf.addfile(info)
        dest = tmp_path / "dest"
        dest.mkdir()
        with pytest.raises(ValueError, match="not a valid openagentd export"):
            import_config(arch, config_dir=dest)

    def test_import_symlinks_not_extracted(self, tmp_path: Path):
        """Symlink entries alongside real files are silently ignored — never written."""
        arch = tmp_path / "symlink.tar.gz"
        with tarfile.open(arch, "w:gz") as tf:
            content = b"safe"
            fi = tarfile.TarInfo(name="openagentd-export/agents/safe.md")
            fi.size = len(content)
            tf.addfile(fi, io.BytesIO(content))
            si = tarfile.TarInfo(name="openagentd-export/evil.md")
            si.type = tarfile.SYMTYPE
            si.linkname = "/etc/passwd"
            tf.addfile(si)
        dest = tmp_path / "dest"
        dest.mkdir()
        result = import_config(arch, config_dir=dest)
        assert result.files_written == ["agents/safe.md"]
        assert not (dest / "evil.md").exists()
        assert not (dest / "evil.md").is_symlink()

    def test_import_rejects_destination_symlink_escape(self, tmp_path: Path):
        """A destination symlink must not redirect an imported file outside config."""
        arch = tmp_path / "symlink-escape.tar.gz"
        with tarfile.open(arch, "w:gz") as tf:
            content = b"evil"
            fi = tarfile.TarInfo(name="openagentd-export/agents/lead.md")
            fi.size = len(content)
            tf.addfile(fi, io.BytesIO(content))

        dest = tmp_path / "dest"
        dest.mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        (dest / "agents").symlink_to(outside, target_is_directory=True)

        with pytest.raises(ValueError, match="path traversal"):
            import_config(arch, config_dir=dest)

        assert not (outside / "lead.md").exists()

    def test_import_blocks_str_prefix_path_traversal(self, tmp_path: Path):
        """An entry with .. after the archive root prefix is rejected."""
        arch = tmp_path / "prefix-attack.tar.gz"
        with tarfile.open(arch, "w:gz") as tf:
            content = b"evil"
            fi = tarfile.TarInfo(name="openagentd-export/../evil.md")
            fi.size = len(content)
            tf.addfile(fi, io.BytesIO(content))
        dest = tmp_path / "dest"
        dest.mkdir()
        with pytest.raises(ValueError, match="path traversal"):
            import_config(arch, config_dir=dest)


# ---------------------------------------------------------------------------
# _redact_env unit tests
# ---------------------------------------------------------------------------


class TestRedactEnv:
    """Unit tests for the secret-redaction function, independent of archive I/O."""

    @pytest.fixture(autouse=True)
    def _import(self):
        from app.cli.commands.export import _redact_env

        self._redact = _redact_env

    def _r(self, line: str) -> str:
        return self._redact(line).rstrip("\n")

    # ── Should redact (all real settings.py secret vars) ──────────────────

    @pytest.mark.parametrize(
        "line",
        [
            "OPENAI_API_KEY=sk-secret",
            "ANTHROPIC_API_KEY=ant-secret",
            "GOOGLE_API_KEY=gk-secret",
            "ZAI_API_KEY=zai-secret",
            "OPENROUTER_API_KEY=or-secret",
            "NVIDIA_API_KEY=nv-secret",
            "XAI_API_KEY=xai-secret",
            "DEEPSEEK_API_KEY=ds-secret",
            "ROUTER9_API_KEY=r9-secret",
            "CLIPROXY_API_KEY=cp-secret",
            "OLLAMA_API_KEY=ol-secret",
            "VERTEXAI_API_KEY=vx-secret",
            "AWS_BEARER_TOKEN_BEDROCK=bedrock-api-key-secret",
            "ACCESS_KEY=direct-secret",
            "MY_TOKEN=tok-abc",
            "MY_PASSWORD=hunter2",
            "MY_SECRET=s3cr3t",
            "MY_SECRET_KEY=s3cr3t",
        ],
    )
    def test_secret_vars_are_redacted(self, line: str):
        result = self._r(line)
        key = line.split("=", 1)[0]
        assert result == f"{key}=", f"Expected '{key}=' but got {result!r}"

    # ── Should NOT redact ─────────────────────────────────────────────────

    @pytest.mark.parametrize(
        "line",
        [
            "APP_ENV=production",
            "API_HOST=0.0.0.0",
            "API_PORT=4082",
            "ANTHROPIC_BASE_URL=https://api.anthropic.com",
            "OLLAMA_BASE_URL=http://localhost:11434/v1",
            "ROUTER9_BASE_URL=http://localhost:20128/v1",
            "CLIPROXY_BASE_URL=http://localhost:8317/v1",
            "GOOGLE_CLOUD_PROJECT=my-project",
            "GOOGLE_CLOUD_LOCATION=global",
            "AWS_BEDROCK_REGION=us-east-1",
            "AWS_BEDROCK_PROFILE=default",
            "# OPENAI_API_KEY=commented-out",
            "",  # blank line
            "OPENAI_API_KEY=",  # already blank — preserved as-is
        ],
    )
    def test_non_secret_vars_are_preserved(self, line: str):
        result = self._r(line)
        assert result == line.rstrip("\n"), (
            f"Expected {line!r} to be unchanged, got {result!r}"
        )

    def test_multiline_env_file(self):
        """Full .env content: secrets blanked, rest preserved, order kept."""
        content = (
            "APP_ENV=production\n"
            "OPENAI_API_KEY=sk-abc\n"
            "ANTHROPIC_API_KEY=ant-xyz\n"
            "# A comment\n"
            "OPENAI_BASE_URL=https://api.openai.com\n"
            "\n"
            "GOOGLE_API_KEY=gk-foo\n"
        )
        result = self._redact(content)
        assert "APP_ENV=production" in result
        assert "OPENAI_API_KEY=\n" in result
        assert "sk-abc" not in result
        assert "ANTHROPIC_API_KEY=\n" in result
        assert "ant-xyz" not in result
        assert "# A comment" in result
        assert "OPENAI_BASE_URL=https://api.openai.com" in result
        assert "GOOGLE_API_KEY=\n" in result
        assert "gk-foo" not in result
