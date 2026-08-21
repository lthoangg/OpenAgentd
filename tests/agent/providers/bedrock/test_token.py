"""Tests for app/agent/providers/bedrock/token.py."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from app.agent.providers.bedrock.token import (
    generate_bedrock_bearer_token,
    resolve_aws_credentials,
)


def test_generate_bedrock_bearer_token_with_env_vars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
    monkeypatch.setenv(
        "AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    )
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)

    token = generate_bedrock_bearer_token(region="us-east-1")
    assert token.startswith("bedrock-api-key-")

    payload_b64 = token[len("bedrock-api-key-") :]
    decoded = base64.b64decode(payload_b64).decode("utf-8")
    assert "bedrock.amazonaws.com" in decoded
    assert "Action=CallWithBearerToken" in decoded
    assert "AKIAIOSFODNN7EXAMPLE" in decoded


def test_resolve_aws_credentials_from_ini_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    aws_dir = tmp_path / ".aws"
    aws_dir.mkdir(parents=True)
    (aws_dir / "credentials").write_text(
        "[profile-x]\n"
        "aws_access_key_id = AKIA_FROM_FILE\n"
        "aws_secret_access_key = SECRET_FROM_FILE\n",
        encoding="utf-8",
    )

    ak, sk, st = resolve_aws_credentials("profile-x")
    assert ak == "AKIA_FROM_FILE"
    assert sk == "SECRET_FROM_FILE"
    assert st is None


def test_resolve_aws_credentials_raises_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    with pytest.raises(
        ValueError, match="AWS credentials for profile 'missing' not found"
    ):
        resolve_aws_credentials("missing")
