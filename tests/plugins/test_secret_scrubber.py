from __future__ import annotations

from plugins import secret_scrubber


def test_scrub_redacts_structured_credentials_and_known_tokens() -> None:
    text = "\n".join(
        [
            'OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz123456"',
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
            "DATABASE_URL=postgres://alice:hunter2@db.example.com/app",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
        ]
    )

    scrubbed, count = secret_scrubber._scrub(text)

    assert scrubbed == "\n".join(
        [
            'OPENAI_API_KEY="[REDACTED]"',
            "Authorization: Bearer [REDACTED]",
            "DATABASE_URL=postgres://alice:[REDACTED]@db.example.com/app",
            "[REDACTED]",
        ]
    )
    assert count == 4


def test_scrub_redacts_json_credentials() -> None:
    text = '{"api_key":"sk-proj-abcdefghijklmnopqrstuvwxyz123456","password":"hunter2"}'

    scrubbed, count = secret_scrubber._scrub(text)

    assert scrubbed == '{"api_key":"[REDACTED]","password":"[REDACTED]"}'
    assert count == 2


def test_scrub_redacts_private_key_blocks() -> None:
    text = """before
-----BEGIN PRIVATE KEY-----
c3VwZXItc2VjcmV0LWtleQ==
-----END PRIVATE KEY-----
after"""

    scrubbed, count = secret_scrubber._scrub(text)

    assert scrubbed == "before\n[REDACTED PRIVATE KEY]\nafter"
    assert count == 1


def test_scrub_replaces_sensitive_environment_values() -> None:
    scrubbed, count = secret_scrubber._scrub(
        "response=opaque-production-credential",
        environment_values=("opaque-production-credential",),
    )

    assert scrubbed == "response=[REDACTED]"
    assert count == 1


def test_scrub_preserves_benign_secret_related_text() -> None:
    text = "\n".join(["token_budget=4096", 'password_policy="required"'])

    scrubbed, count = secret_scrubber._scrub(text)

    assert scrubbed == text
    assert count == 0


async def test_plugin_scrubs_every_tool_result(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "opaque-production-credential")
    handlers = await secret_scrubber.plugin()
    output = {"output": "result: opaque-production-credential"}

    await handlers["tool.after"](
        {"tool": "shell", "session_id": "session-1", "call_id": "call-1"}, output
    )

    assert output["output"] == "result: [REDACTED]"
