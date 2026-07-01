"""Smoke-test provider-neutral fast_mode handling on /team/chat.

The script uses direct shell dispatch (``shell=true``) so it verifies the API
request/persistence path without consuming LLM tokens. It sends:

1. A non-Codex model with ``fast_mode=true`` and asserts the turn succeeds but
   does not persist ``extra.service_tier``.
2. Optionally, a Codex model with ``fast_mode=true`` and asserts the persisted
   user message records ``extra.service_tier == "fast"``.

Usage:
  uv run python -m manual.fast_mode
  uv run python -m manual.fast_mode --codex-model codex:gpt-5.4
  uv run python -m manual.fast_mode --non-codex-model openai:gpt-5.5
  uv run python -m manual.fast_mode --base http://localhost:4082/api
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from collections.abc import Iterable

import httpx


from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
DEFAULT_COMMAND = "printf 'openagentd-fast-mode-smoke-ok\\n'"
DEFAULT_EXPECT = "openagentd-fast-mode-smoke-ok"
DEFAULT_CODEX_MODEL = "codex:gpt-5.4"


def _lead_model(base: str) -> str | None:
    response = httpx.get(f"{base}/team/agents", timeout=30)
    response.raise_for_status()
    for agent in response.json().get("agents", []):
        if agent.get("is_lead"):
            model = agent.get("model")
            return str(model) if model else None
    return None


def _first_registered_model(base: str, *, codex: bool) -> str | None:
    response = httpx.get(f"{base}/agents/registry", timeout=30)
    response.raise_for_status()
    for entry in response.json().get("models", []):
        model_id = str(entry.get("id") or "")
        if bool(model_id.startswith("codex:")) == codex:
            return model_id
    return None


def _post_shell_turn(
    base: str,
    *,
    model: str | None,
    fast_mode: bool,
    command: str,
) -> str:
    payload: dict[str, str] = {
        "message": f"!{command}",
        "shell": "true",
        "session_id": str(uuid.uuid7()),
    }
    if model is not None:
        payload["model"] = model
    if fast_mode:
        payload["fast_mode"] = "true"

    response = httpx.post(f"{base}/team/chat", data=payload, timeout=30)
    if response.status_code == 422 and model is not None:
        detail = response.json().get("detail")
        raise AssertionError(
            f"model {model!r} is not accepted by the registry: {detail}"
        )
    response.raise_for_status()
    data = response.json()
    if data.get("status") != "accepted":
        raise AssertionError(f"expected accepted response, got {data}")
    return str(data["session_id"])


def _stream_until_done(base: str, session_id: str, wait: int) -> str:
    output_parts: list[str] = []
    current_event = "message"
    data_buf: list[str] = []
    start = time.monotonic()

    with httpx.stream(
        "GET", f"{base}/team/{session_id}/stream", timeout=wait + 5
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():
            if time.monotonic() - start > wait:
                raise TimeoutError(f"timed out waiting for session {session_id}")
            if line.startswith("event:"):
                current_event = line[6:].strip()
            elif line.startswith("data:"):
                data_buf.append(line[5:].strip())
            elif line == "":
                if not data_buf:
                    continue
                data = json.loads("\n".join(data_buf))
                data_buf = []
                if current_event == "tool_output_delta" and data.get("name") == "shell":
                    output_parts.append(str(data.get("text") or ""))
                elif current_event == "tool_end" and data.get("name") == "shell":
                    output_parts.append(str(data.get("result") or ""))
                elif current_event == "error":
                    raise AssertionError(f"stream error: {data}")
                elif current_event == "done":
                    return "".join(output_parts)

    raise AssertionError(f"stream closed before done for session {session_id}")


def _lead_history(base: str, session_id: str) -> list[dict]:
    response = httpx.get(
        f"{base}/team/{session_id}/history", params={"limit": 1000}, timeout=30
    )
    response.raise_for_status()
    return list(response.json()["lead"]["messages"])


def _user_shell_extra(history: Iterable[dict], command: str) -> dict:
    expected_content = f"!{command}"
    for message in history:
        if (
            message.get("role") == "user"
            and (message.get("content") or "").strip() == expected_content
        ):
            extra = message.get("extra") or {}
            if extra.get("kind") == "user_shell":
                return dict(extra)
    raise AssertionError(f"did not find persisted shell user row for {expected_content!r}")


def _run_case(
    base: str,
    *,
    label: str,
    model: str | None,
    fast_mode: bool,
    expect_service_tier: str | None,
    command: str,
    expect_output: str,
    wait: int,
) -> None:
    print(f"case: {label}")
    print(f"  model={model or '<session default>'} fast_mode={fast_mode}")
    session_id = _post_shell_turn(
        base, model=model, fast_mode=fast_mode, command=command
    )
    print(f"  session={session_id}")

    output = _stream_until_done(base, session_id, wait)
    if expect_output not in output:
        raise AssertionError(f"shell output missing {expect_output!r}: {output!r}")

    extra = _user_shell_extra(_lead_history(base, session_id), command)
    actual_service_tier = extra.get("service_tier")
    if actual_service_tier != expect_service_tier:
        raise AssertionError(
            "service_tier mismatch: "
            f"expected {expect_service_tier!r}, got {actual_service_tier!r}; "
            f"extra={extra}"
        )
    print(f"  service_tier={actual_service_tier!r} ok")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=BASE)
    parser.add_argument(
        "--non-codex-model",
        default=None,
        help=(
            "Registered non-Codex model for the unsupported-provider ignore check. "
            "Defaults to the current session/team model."
        ),
    )
    parser.add_argument(
        "--codex-model",
        default=None,
        help=(
            "Registered Codex model for the persistence check. "
            f"Use {DEFAULT_CODEX_MODEL!r} when Codex is configured."
        ),
    )
    parser.add_argument("--command", default=DEFAULT_COMMAND)
    parser.add_argument("--expect", default=DEFAULT_EXPECT)
    parser.add_argument("--wait", type=int, default=30)
    args = parser.parse_args()

    base = args.base.rstrip("/")
    command = args.command.lstrip("!").strip()
    if not command:
        raise SystemExit("--command must not be blank")

    lead_model = _lead_model(base)
    non_codex_model = args.non_codex_model
    if non_codex_model is None and (lead_model or "").startswith("codex:"):
        non_codex_model = _first_registered_model(base, codex=False)

    if non_codex_model is not None or not (lead_model or "").startswith("codex:"):
        _run_case(
            base,
            label="non-Codex fast_mode persists service_tier=fast",
            model=non_codex_model,
            fast_mode=True,
            expect_service_tier="fast",
            command=command,
            expect_output=args.expect,
            wait=args.wait,
        )
    else:
        print(
            "case: unsupported/non-Codex fast_mode skipped "
            "(lead model is Codex and no registered non-Codex model was found; "
            "pass --non-codex-model ID when one is configured)"
        )

    codex_model = args.codex_model
    if codex_model is None and (lead_model or "").startswith("codex:"):
        codex_model = None
    elif codex_model is None:
        codex_model = _first_registered_model(base, codex=True)

    if codex_model is not None or (lead_model or "").startswith("codex:"):
        _run_case(
            base,
            label="Codex fast_mode persists service_tier=fast",
            model=codex_model,
            fast_mode=True,
            expect_service_tier="fast",
            command=command,
            expect_output=args.expect,
            wait=args.wait,
        )
    else:
        print(
            "case: Codex fast_mode persistence skipped "
            f"(pass --codex-model {DEFAULT_CODEX_MODEL} when Codex is configured)"
        )

    print("fast_mode smoke: ok")


if __name__ == "__main__":
    main()
