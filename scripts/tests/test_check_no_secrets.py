from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path


def _load_module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "check_no_secrets.py"
    spec = importlib.util.spec_from_file_location("check_no_secrets", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["check_no_secrets"] = module  # dataclasses look the module up
    spec.loader.exec_module(module)
    return module


mod = _load_module()


def _rules(text: str, allow=None, deny=None, message=False) -> list[str]:
    return [f.rule for f in mod.scan_text(text, "f", allow or [], deny or [], message=message)]


def test_cloud_tokens_are_found_and_never_printed_in_full():
    token = "t1." + "A" * 30 + "." + "B" * 43
    findings = mod.scan_text(f'let t = "{token}";', "f", [], [])
    assert [f.rule for f in findings] == ["cloud token"]
    assert token not in findings[0].render()
    # Not even a prefix: only where, which rule, and the length.
    assert "t1." not in findings[0].render() and "AAAA" not in findings[0].render()
    assert findings[0].render() == f"f:1: cloud token: [{len(token)} chars]"
    assert _rules("e1." + "x" * 24 + "." + "y" * 24) == ["cloud token"]
    assert _rules("n1." + "x" * 24 + "." + "y" * 24) == ["cloud token"]


def test_infrastructure_ids_next_to_their_field_names():
    assert _rules('database_id = "' + "0123456789abcdef" * 2 + '"') == ["infrastructure id"]
    assert _rules('"account_id": "' + "a" * 32 + '"') == ["infrastructure id"]
    # A protocol account id (base64url, 38 chars) is not an infrastructure id.
    assert _rules('"account_id": "wFuhTNq3Ra-EVe24nCtFWcuYs76uT37NoTBSwQ"') == []


def test_personal_emails_but_not_placeholders_or_file_names():
    personal = "someone" + "@" + "gmail.com"  # built from parts so the scan of this file stays clean
    assert _rules(f"contact {personal}") == ["email address"]
    assert _rules("user@example.com and team@openagentd.dev") == []
    assert _rules("icon-128x128@2x.png") == []
    # A trailer is skipped in a commit message only; in a file it is scanned.
    assert _rules(f"Signed-off-by: Someone <{personal}>", message=True) == []
    assert _rules(f"Signed-off-by: Someone <{personal}>") == ["email address"]


def test_an_allowed_value_exempts_only_itself():
    allow = [re.compile(r"git@github\.com")]
    personal = "someone" + "@" + "gmail.com"
    assert _rules("remote git@github.com:org/repo", allow=allow) == []
    # The rest of the line is still scanned.
    token = "n1." + "x" * 24 + "." + "y" * 24
    assert _rules(f"git@github.com {token} {personal}", allow=allow) == ["cloud token", "email address"]
    # A pattern that matches only part of a finding does not exempt it.
    assert _rules("evil" + "git@github.com", allow=allow) == ["email address"]


def test_private_key_needs_a_body():
    assert _rules("-----BEGIN RSA PRIVATE KEY-----\\n1\\n-----END") == []  # gitleaks:allow
    body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ"
    assert _rules(f"-----BEGIN PRIVATE KEY-----\n{body}\n") == ["private key block"]


def test_allowlist_and_denylist():
    line = "AKIAIOSFODNN7EXAMPLE"
    assert _rules(line) == ["AWS access key"]
    assert _rules(line, allow=[re.compile("AKIAIOSFODNN7EXAMPLE")]) == []
    assert _rules("id is my-private-literal-1234", deny=["my-private-literal-1234"]) == ["denylisted value"]


def test_the_published_vectors_are_skipped():
    assert mod._skipped("appv3/contract/tunnel_vectors.json")
    assert not mod._skipped("appv3/contract/tunnel.md")
