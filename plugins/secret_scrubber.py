"""Redact credentials from tool results before they reach model context.

The plugin applies conservative built-in detectors for common credential shapes
and exact matches for values held in sensitive environment variables. It never
logs the matched values and leaves the original result unchanged when no secret
is found.

Install
-------
Copy this file into ``{OPENAGENTD_CONFIG_DIR}/plugins/`` and restart openagentd.

Scope
-----
This protects model-facing tool results. It cannot redact values that core code
may already have written to application logs, telemetry, or artifact files.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterable
from typing import Any, Match

from loguru import logger

_REDACTED = "[REDACTED]"
_REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]"

_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?P<label>(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----"
    r".*?"
    r"-----END (?P=label)-----",
    re.DOTALL,
)
_AUTHORIZATION_RE = re.compile(
    r"(?i)(\b(?:authorization|proxy-authorization)\s*[:=]\s*"
    r"(?:bearer|basic)\s+)([^\s,;]+)"
)
_CREDENTIAL_URL_RE = re.compile(
    r"(\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)([^\s/@]+)(@)",
    re.IGNORECASE,
)
_ASSIGNMENT_RE = re.compile(
    r"(?i)((?:[\"']?)\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|"
    r"auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|"
    r"private[_-]?key)(?:[\"']?)\s*[:=]\s*)([\"']?)([^\s\"',;]+)([\"']?)"
)
_KNOWN_TOKEN_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
)
_SENSITIVE_ENV_NAME_RE = re.compile(
    r"(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|"
    r"PASSWD|CREDENTIAL|SECRET|TOKEN|COOKIE)",
    re.IGNORECASE,
)
_PLACEHOLDER_VALUES = frozenset(
    {
        "change-me",
        "changeme",
        "example",
        "placeholder",
        "redacted",
        "replace-me",
        "replace_me",
        "secret",
        "test",
    }
)


def _sensitive_environment_values() -> tuple[str, ...]:
    values: set[str] = set()
    for name, value in os.environ.items():
        if not _SENSITIVE_ENV_NAME_RE.search(name):
            continue
        stripped = value.strip()
        if (
            len(stripped) < 8
            or stripped.lower() in _PLACEHOLDER_VALUES
            or stripped == _REDACTED
            or stripped.startswith(("/", "./", "../"))
        ):
            continue
        values.add(stripped)
    return tuple(sorted(values, key=len, reverse=True))


def _substitute(
    pattern: re.Pattern[str],
    replacement: str | Callable[[Match[str]], str],
    text: str,
) -> tuple[str, int]:
    return pattern.subn(replacement, text)


def _redact_assignment(match: Match[str]) -> str:
    prefix, opening_quote, value, closing_quote = match.groups()
    if value.lower() in _PLACEHOLDER_VALUES or value == _REDACTED:
        return match.group(0)
    quote = opening_quote if opening_quote == closing_quote else ""
    return f"{prefix}{quote}{_REDACTED}{quote}"


def _scrub(
    text: str,
    *,
    environment_values: Iterable[str] = (),
) -> tuple[str, int]:
    """Return redacted *text* and the number of replacements made."""
    scrubbed = text
    replacements = 0

    for value in sorted(set(environment_values), key=len, reverse=True):
        if not value or value == _REDACTED:
            continue
        occurrences = scrubbed.count(value)
        if occurrences:
            scrubbed = scrubbed.replace(value, _REDACTED)
            replacements += occurrences

    scrubbed, count = _substitute(_PRIVATE_KEY_RE, _REDACTED_PRIVATE_KEY, scrubbed)
    replacements += count
    scrubbed, count = _substitute(
        _AUTHORIZATION_RE, lambda match: f"{match.group(1)}{_REDACTED}", scrubbed
    )
    replacements += count
    scrubbed, count = _substitute(
        _CREDENTIAL_URL_RE,
        lambda match: f"{match.group(1)}{_REDACTED}{match.group(3)}",
        scrubbed,
    )
    replacements += count
    scrubbed, count = _substitute(_ASSIGNMENT_RE, _redact_assignment, scrubbed)
    replacements += count

    for pattern in _KNOWN_TOKEN_RES:
        scrubbed, count = _substitute(pattern, _REDACTED, scrubbed)
        replacements += count

    return scrubbed, replacements


async def plugin() -> dict[str, Any]:
    environment_values = _sensitive_environment_values()

    async def after(input: dict[str, Any], output: dict[str, Any]) -> None:
        result = output.get("output")
        if not isinstance(result, str) or not result:
            return

        scrubbed, count = _scrub(
            result,
            environment_values=environment_values,
        )
        if count:
            output["output"] = scrubbed
            logger.warning(
                "secret_scrubber_redacted tool={} session={} call_id={} count={}",
                input.get("tool"),
                input.get("session_id"),
                input.get("call_id"),
                count,
            )

    return {"tool.after": after}
