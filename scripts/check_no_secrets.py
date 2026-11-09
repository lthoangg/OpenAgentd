#!/usr/bin/env python3
"""Fail when a secret-shaped value is in the tracked tree or the history.

This repository is public. The check looks for credentials and identifiers
that must never be committed: private keys, OpenAgentd Cloud tokens
(nonces, enrollment sessions, relay tokens), well-known API key shapes,
cloud infrastructure ids next to their field names, and personal email
addresses.

Usage:
    python3 scripts/check_no_secrets.py            # tracked files
    python3 scripts/check_no_secrets.py --history  # every commit (patches and messages)

Known-safe values (published test vectors, documented placeholders) are
listed in ``scripts/secret_scan_allow.txt``. Literal values that must never
appear but must not be published either (your own ids) go, one per line, in
the ignored file ``.openagentd/secret-denylist``.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOW_FILE = ROOT / "scripts" / "secret_scan_allow.txt"
DENY_FILE = ROOT / ".openagentd" / "secret-denylist"

# Files whose content is published test data or binary.
SKIP_PATHS = (
    re.compile(r"^appv3/contract/tunnel_vectors\.json$"),
    re.compile(r"(^|/)(bun\.lock|Cargo\.lock|package-lock\.json)$"),
    re.compile(r"\.(png|jpg|jpeg|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz|wasm)$"),
    re.compile(r"^appv3/vendor/"),
)

EMAIL_OK_DOMAINS = (
    "example.com",
    "example.org",
    "example.net",
    "example",
    "test",
    "localhost",
    "openagentd.dev",
    "users.noreply.github.com",
    "noreply.github.com",
)


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]


RULES: tuple[Rule, ...] = (
    # OpenAgentd Cloud credentials: n1 (nonce), e1 (enrollment session), t1 (relay token).
    Rule("cloud token", re.compile(r"\b[ent]1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}")),
    Rule("GitHub token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})")),
    Rule("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    Rule("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    Rule("Slack token", re.compile(r"\bxox[abprs]-[0-9A-Za-z-]{10,}")),
    Rule("Anthropic or OpenAI key", re.compile(r"\bsk-(?:ant-)?(?:proj-)?[A-Za-z0-9_-]{32,}")),
    Rule(
        "infrastructure id",
        re.compile(
            r"(?i)\b(?:account_id|database_id|zone_id|kv_namespace_id|cf_account)\b[\"' ]*[:=][\"' ]*[0-9a-f]{32}\b"
        ),
    ),
    Rule("email address", re.compile(r"\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b")),
)

# A PEM private key with a real body (a bare header is a redaction test).
PEM_KEY = re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\n|\s)+[A-Za-z0-9+/=]{40,}")

# Domains that are file names (icon@2x.png) or package versions, not mail.
NOT_MAIL_TLDS = frozenset({"png", "jpg", "jpeg", "svg", "ico", "icns", "gif", "webp", "json", "js", "ts", "tsx", "rs", "py", "md"})


@dataclass(frozen=True)
class Finding:
    where: str
    rule: str
    excerpt: str

    def render(self) -> str:
        return f"{self.where}: {self.rule}: {self.excerpt}"


def load_allowlist(path: Path = ALLOW_FILE) -> list[re.Pattern[str]]:
    if not path.exists():
        return []
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            out.append(re.compile(line))
    return out


def load_denylist(path: Path = DENY_FILE) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]


def _redact(value: str) -> str:
    """Never print a found secret in full: CI logs are public too."""
    if len(value) <= 8:
        return value[:2] + "…"
    return value[:6] + "…" + f"({len(value)} chars)"


def _email_ok(domain: str) -> bool:
    domain = domain.lower()
    return any(domain == ok or domain.endswith("." + ok) for ok in EMAIL_OK_DOMAINS)


# Commit trailers carry the committer identity git already publishes.
TRAILER = re.compile(r"^(?i:signed-off-by|co-authored-by):")


def scan_text(
    text: str,
    where: str,
    allow: list[re.Pattern[str]],
    deny: list[str],
) -> list[Finding]:
    findings: list[Finding] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if any(a.search(line) for a in allow) or TRAILER.match(line):
            continue
        for rule in RULES:
            for m in rule.pattern.finditer(line):
                if rule.name == "email address":
                    if _email_ok(m.group(1)) or m.group(1).rsplit(".", 1)[-1].lower() in NOT_MAIL_TLDS:
                        continue
                findings.append(Finding(f"{where}:{lineno}", rule.name, _redact(m.group(0))))
        for literal in deny:
            if literal in line:
                findings.append(Finding(f"{where}:{lineno}", "denylisted value", _redact(literal)))
    for m in PEM_KEY.finditer(text):
        lineno = text.count("\n", 0, m.start()) + 1
        findings.append(Finding(f"{where}:{lineno}", "private key block", _redact(m.group(0))))
    return findings


def _skipped(path: str) -> bool:
    return any(p.search(path) for p in SKIP_PATHS)


def scan_tracked(root: Path, allow: list[re.Pattern[str]], deny: list[str]) -> list[Finding]:
    names = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True
    ).stdout.decode().split("\0")
    findings: list[Finding] = []
    for name in filter(None, names):
        if _skipped(name):
            continue
        path = root / name
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        findings.extend(scan_text(text, name, allow, deny))
    return findings


def scan_history(root: Path, allow: list[re.Pattern[str]], deny: list[str]) -> list[Finding]:
    """Added lines of every commit, plus every commit message."""
    log = subprocess.run(
        ["git", "-C", str(root), "log", "--all", "-p", "--no-color", "--format=commit %H%n%B%n--end-message--"],
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8", "replace")
    findings: list[Finding] = []
    commit = "?"
    file = "?"
    message: list[str] = []
    added: list[str] = []
    in_message = False

    def flush_file() -> None:
        if added and not _skipped(file):
            findings.extend(scan_text("\n".join(added), f"{commit} {file}", allow, deny))
        added.clear()

    for line in log.splitlines():
        if line.startswith("commit ") and len(line) == 47:
            flush_file()
            commit, in_message = line[7:19], True
            continue
        if in_message:
            if line == "--end-message--":
                findings.extend(scan_text("\n".join(message), f"{commit} message", allow, deny))
                message.clear()
                in_message = False
            else:
                message.append(line)
            continue
        if line.startswith("+++ "):
            flush_file()
            file = line[6:] if line.startswith("+++ b/") else "?"
            continue
        if line.startswith("+"):
            added.append(line[1:])
    flush_file()
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail when a secret-shaped value is committed.")
    parser.add_argument("--history", action="store_true", help="scan every commit instead of the tracked tree")
    args = parser.parse_args(argv)
    allow, deny = load_allowlist(), load_denylist()
    findings = (scan_history if args.history else scan_tracked)(ROOT, allow, deny)
    for f in findings:
        print(f.render())
    if findings:
        print(f"\n{len(findings)} possible secret(s). Remove them, or add a reviewed pattern to scripts/secret_scan_allow.txt.")
        return 1
    print("No secrets found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
