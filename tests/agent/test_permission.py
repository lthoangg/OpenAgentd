"""Tests for app/agent/permission.py — rules engine and permission service."""

from __future__ import annotations

import asyncio

import pytest

from app.agent.permission import (
    AutoAllowPermissionService,
    PermissionDeniedError,
    PermissionRejectedError,
    PermissionService,
    Rule,
    evaluate,
    get_permission_service,
    set_permission_service,
)


# ---------------------------------------------------------------------------
# evaluate() — rule engine
# ---------------------------------------------------------------------------


def test_evaluate_no_rules_returns_ask():
    rule = evaluate("shell", "git status")
    assert rule.action == "ask"


def test_evaluate_allow_wildcard():
    rules = [Rule(permission="*", pattern="*", action="allow")]
    rule = evaluate("shell", "git status", rules)
    assert rule.action == "allow"


def test_evaluate_deny_specific_tool():
    rules = [Rule(permission="shell", pattern="*", action="deny")]
    rule = evaluate("shell", "git status", rules)
    assert rule.action == "deny"


def test_evaluate_last_rule_wins():
    """More specific rule appended later overrides broad wildcard."""
    rules = [
        Rule(permission="*", pattern="*", action="deny"),
        Rule(permission="shell", pattern="git *", action="allow"),
    ]
    rule = evaluate("shell", "git status", rules)
    assert rule.action == "allow"


def test_evaluate_pattern_glob_matching():
    rules = [Rule(permission="shell", pattern="git *", action="allow")]
    # Matches
    assert evaluate("shell", "git status", rules).action == "allow"
    assert evaluate("shell", "git commit -m 'msg'", rules).action == "allow"
    # Does not match (falls through to default ask)
    assert evaluate("shell", "rm -rf /", rules).action == "ask"


def test_evaluate_permission_glob():
    """Wildcard permission glob matches multiple tools."""
    rules = [Rule(permission="*", pattern="ls *", action="allow")]
    assert evaluate("shell", "ls -la", rules).action == "allow"
    assert evaluate("read", "ls -la", rules).action == "allow"


def test_evaluate_multiple_rulesets():
    base = [Rule(permission="*", pattern="*", action="ask")]
    session = [Rule(permission="shell", pattern="git status", action="allow")]
    rule = evaluate("shell", "git status", base, session)
    assert rule.action == "allow"


def test_evaluate_deny_wins_when_last():
    rules = [
        Rule(permission="shell", pattern="*", action="allow"),
        Rule(permission="shell", pattern="rm *", action="deny"),
    ]
    assert evaluate("shell", "rm file.txt", rules).action == "deny"
    assert evaluate("shell", "ls -la", rules).action == "allow"


# ---------------------------------------------------------------------------
# PermissionDeniedError
# ---------------------------------------------------------------------------


def test_permission_denied_error_message():
    rules = [Rule(permission="shell", pattern="*", action="deny")]
    err = PermissionDeniedError("shell", "rm file", rules)
    assert "shell" in str(err)
    assert "rm file" in str(err)


# ---------------------------------------------------------------------------
# PermissionService.ask()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ask_allow_returns_immediately():
    service = PermissionService(
        session_id="s1",
        base_ruleset=[Rule(permission="shell", pattern="*", action="allow")],
    )
    # Should not raise or block
    await service.ask("shell", ["git status"])


@pytest.mark.asyncio
async def test_ask_deny_raises_denied_error():
    service = PermissionService(
        session_id="s1",
        base_ruleset=[Rule(permission="shell", pattern="*", action="deny")],
    )
    with pytest.raises(PermissionDeniedError):
        await service.ask("shell", ["git status"])


@pytest.mark.asyncio
async def test_ask_and_reply_once():
    """ask() blocks until reply() is called with 'once'."""
    service = PermissionService(session_id="s1")

    async def _reply_later():
        await asyncio.sleep(0.01)
        reqs = service.list_pending()
        assert len(reqs) == 1
        service.reply(reqs[0].id, "once")

    asyncio.create_task(_reply_later())
    await service.ask("shell", ["git status"])  # should not raise


@pytest.mark.asyncio
async def test_ask_and_reply_always_adds_to_session_ruleset():
    """reply('always') adds pattern to session ruleset so next call is auto-allowed."""
    service = PermissionService(session_id="s1")

    async def _reply_always():
        await asyncio.sleep(0.01)
        reqs = service.list_pending()
        service.reply(reqs[0].id, "always")

    asyncio.create_task(_reply_always())
    await service.ask("shell", ["git status"], always_patterns=["git *"])

    # Second call should auto-allow (session_ruleset has git * → allow)
    await service.ask("shell", ["git commit"])  # no reply needed


@pytest.mark.asyncio
async def test_ask_and_reply_reject_raises():
    """reply('reject') causes ask() to raise PermissionRejectedError."""
    service = PermissionService(session_id="s1")

    async def _reject():
        await asyncio.sleep(0.01)
        reqs = service.list_pending()
        service.reply(reqs[0].id, "reject")

    asyncio.create_task(_reject())
    with pytest.raises(PermissionRejectedError):
        await service.ask("shell", ["rm file"])


@pytest.mark.asyncio
async def test_reply_unknown_request_returns_false():
    service = PermissionService(session_id="s1")
    result = service.reply("nonexistent-id", "always")
    assert result is False


# ---------------------------------------------------------------------------
# AutoAllowPermissionService
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auto_allow_service_allows_without_blocking():
    service = AutoAllowPermissionService(session_id="s1")
    # Should return immediately without any reply
    await service.ask("shell", ["git status"])
    await service.ask("shell", ["rm file.txt"])


@pytest.mark.asyncio
async def test_auto_allow_service_still_denies_deny_rules():
    service = AutoAllowPermissionService(
        session_id="s1",
        base_ruleset=[Rule(permission="shell", pattern="sudo *", action="deny")],
    )
    with pytest.raises(PermissionDeniedError):
        await service.ask("shell", ["sudo rm -rf /"])

    # Other commands auto-allowed
    await service.ask("shell", ["git status"])


@pytest.mark.asyncio
async def test_auto_allow_service_fires_on_ask_callback():
    fired = []

    def callback(req):
        fired.append(req)

    service = AutoAllowPermissionService(session_id="s1", on_ask=callback)
    await service.ask("shell", ["git status"])
    assert len(fired) == 1
    assert fired[0].tool == "shell"
    assert "git status" in fired[0].patterns


# ---------------------------------------------------------------------------
# Context-var integration
# ---------------------------------------------------------------------------


def test_get_permission_service_returns_default():
    """get_permission_service() returns a default service when no context is set."""
    service = get_permission_service()
    assert service is not None
    assert isinstance(service, PermissionService)


def test_set_permission_service_sets_context():
    """set_permission_service() makes the service accessible via get_permission_service()."""
    custom = AutoAllowPermissionService(session_id="test-ctx")
    token = set_permission_service(custom)
    try:
        retrieved = get_permission_service()
        assert retrieved is custom
    finally:
        from app.agent.permission import _permission_ctx

        _permission_ctx.reset(token)


# ---------------------------------------------------------------------------
# PermissionService.auto_allow_all_pending
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auto_allow_all_pending():
    """auto_allow_all_pending() resolves all pending futures."""
    service = PermissionService(session_id="s1")

    tasks = [asyncio.create_task(service.ask("shell", [f"cmd{i}"])) for i in range(3)]
    await asyncio.sleep(0.01)
    count = service.auto_allow_all_pending()
    assert count == 3

    # All tasks should complete now
    await asyncio.gather(*tasks)
