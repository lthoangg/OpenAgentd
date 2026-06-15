"""Live/direct smoke for cache-first summarization compaction.

Live mode drives a short team session, forces ``/compact``, then inspects OTel
spans for summarization cache reads. Direct mode does not need a server or LLM:
it exercises the hook chain and verifies the summarizer request has the same
provider-visible prefix as a normal chat request, with one extra final user
message that asks for summarization.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from app.agent.hooks.base import BaseAgentHook
from app.agent.hooks.summarization import SummarizationHook
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    FunctionCall,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolMessage,
)
from app.agent.state import (
    AgentState,
    ModelRequest,
    RunContext,
    UsageInfo,
    build_model_chain,
)

BASE = "http://localhost:8000/api"
SPANS = Path(".openagentd/dev/state/otel/spans")
DEFAULT_MIN_CACHE_RATIO = 0.10


def wait_done(base: str, sid: str, timeout: int) -> None:
    start = time.monotonic()
    with httpx.stream("GET", f"{base}/team/{sid}/stream", timeout=timeout + 5) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if time.monotonic() - start > timeout:
                raise TimeoutError(f"timeout waiting for {sid}")
            if line.startswith("event:") and "done" in line:
                return


def send(
    base: str, message: str, sid: str | None, timeout: int, model: str | None = None
) -> str:
    payload = {"message": message}
    if sid:
        payload["session_id"] = sid
    if model:
        payload["model"] = model
    resp = httpx.post(f"{base}/team/chat", data=payload, timeout=30)
    resp.raise_for_status()
    sid = resp.json()["session_id"]
    wait_done(base, sid, timeout)
    return sid


def compact(base: str, sid: str, timeout: int) -> None:
    resp = httpx.post(
        f"{base}/team/commands",
        json={"command": "compact", "session_id": sid},
        timeout=30,
    )
    resp.raise_for_status()
    wait_done(base, sid, timeout)


def attrs_for_session(
    sid: str, spans_dir: Path = SPANS
) -> list[tuple[str, dict[str, Any]]]:
    rows: list[tuple[str, dict[str, Any]]] = []
    trace_ids: set[str] = set()
    time.sleep(2)
    for path in sorted(spans_dir.glob("*.jsonl")):
        for line in path.open(encoding="utf-8"):
            if sid not in line:
                continue
            data = json.loads(line)
            trace_id = data.get("trace_id")
            if isinstance(trace_id, str):
                trace_ids.add(trace_id)

    for path in sorted(spans_dir.glob("*.jsonl")):
        for line in path.open(encoding="utf-8"):
            data = json.loads(line)
            if sid not in line and data.get("trace_id") not in trace_ids:
                continue
            name = data.get("name", "")
            if name.startswith("chat") or name.startswith("summarization"):
                rows.append((name, data.get("attributes", {})))
    return rows


def cache_ratio(attrs: dict[str, Any]) -> float:
    input_tokens = int(attrs.get("gen_ai.usage.input_tokens") or 0)
    cached_tokens = int(attrs.get("gen_ai.usage.cache_read.input_tokens") or 0)
    if input_tokens <= 0:
        return 0.0
    return cached_tokens / input_tokens


def summarization_cache_rows(
    rows: list[tuple[str, dict[str, Any]]],
) -> list[tuple[str, dict[str, Any], float]]:
    result: list[tuple[str, dict[str, Any], float]] = []
    for name, attrs in rows:
        if not name.startswith("summarization"):
            continue
        input_tokens = int(attrs.get("gen_ai.usage.input_tokens") or 0)
        if input_tokens <= 0:
            continue
        result.append((name, attrs, cache_ratio(attrs)))
    return result


def print_usage_rows(rows: list[tuple[str, dict[str, Any]]]) -> None:
    for name, attrs in rows:
        usage = {
            k: v
            for k, v in attrs.items()
            if "usage" in k
            or k.startswith("summarization")
            or k == "gen_ai.request.message_count"
        }
        ratio = cache_ratio(attrs)
        if usage:
            usage["cache_ratio"] = round(ratio, 4)
        print(name, usage)


class _AppendPromptHook(BaseAgentHook):
    async def wrap_model_call(self, ctx, state, request, handler):
        return await handler(
            request.override(
                system_prompt=(
                    request.system_prompt
                    + "\n\nCurrent date (UTC): 2026-06-15"
                    + "\n\n## Workspace Instructions\nUse project rules."
                )
            )
        )


class _CapturingProvider(LLMProviderBase):
    model = "codex:gpt-5.5"
    provider_name = "codex"

    def __init__(self) -> None:
        super().__init__()
        self.messages: list[ChatMessage] | None = None

    async def chat(self, messages, tools=None, **kwargs):
        return AssistantMessage(content="Manual summary.")

    def stream(self, messages, tools=None, **kwargs):
        self.messages = list(messages)

        async def _gen():
            class Delta:
                content = "Manual summary."

            class Choice:
                delta = Delta()

            class Chunk:
                choices = [Choice()]
                usage = None

            yield Chunk()

        return _gen()


async def run_direct() -> dict[str, Any]:
    provider = _CapturingProvider()
    summarization = SummarizationHook(
        llm_provider=provider,
        summary_prompt="summarize exactly",
        prompt_token_threshold=1,
        keep_last_assistants=0,
    )

    skill_call = AssistantMessage(
        content=None,
        tool_calls=[
            ToolCall(
                id="call_skill",
                function=FunctionCall(
                    name="skill", arguments='{"skill_name":"guidelines"}'
                ),
            )
        ],
    )
    skill_result = ToolMessage(
        content="# Guidelines\nUse surgical changes.",
        tool_call_id="call_skill",
        name="skill",
    )
    state = AgentState(
        messages=[HumanMessage(content="load guidelines"), skill_call, skill_result],
        usage=UsageInfo(last_prompt_tokens=9999),
        system_prompt="base prompt",
    )
    ctx = RunContext(session_id="manual", run_id="manual-run", agent_name="lead")
    request = ModelRequest(
        messages=tuple(state.messages_for_llm),
        system_prompt=state.system_prompt,
    )

    await summarization.before_model(ctx, state, request)

    handled: list[ModelRequest] = []

    async def handler(req: ModelRequest) -> AssistantMessage:
        handled.append(req)
        return AssistantMessage(content="normal response")

    chain = build_model_chain([_AppendPromptHook(), summarization], ctx, state, handler)
    await chain(request)

    final_prompt = (
        "base prompt\n\nCurrent date (UTC): 2026-06-15"
        "\n\n## Workspace Instructions\nUse project rules."
    )
    normal_prefix: list[ChatMessage] = [
        SystemMessage(content=final_prompt),
        *request.messages,
    ]
    assert provider.messages is not None
    summarizer_prefix = provider.messages[:-1]

    assert isinstance(provider.messages[0], SystemMessage)
    assert provider.messages[0].content == final_prompt
    assert skill_call in provider.messages
    assert skill_result in provider.messages
    assert len(summarizer_prefix) == len(normal_prefix)
    for left, right in zip(summarizer_prefix, normal_prefix, strict=True):
        assert type(left) is type(right)
        assert left.content == right.content
    assert isinstance(provider.messages[-1], HumanMessage)
    assert "summarize exactly" in (provider.messages[-1].content or "")
    assert handled and any(m.is_summary for m in handled[0].messages)

    return {
        "shared_prefix_messages": len(summarizer_prefix),
        "skill_included": skill_result in provider.messages,
        "final_system_prompt_chars": len(provider.messages[0].content or ""),
        "summary_forwarded": any(m.is_summary for m in handled[0].messages),
    }


def run_live(args: argparse.Namespace) -> int:
    base = args.base.rstrip("/")
    sid: str | None = args.session_id
    labels = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
    for i in range(args.turns):
        label = labels[i % len(labels)]
        sid = send(
            base,
            f"cache smoke: reply with exactly {label}",
            sid,
            args.wait,
            model=args.model,
        )
    assert sid is not None
    print(f"session: {sid}")
    compact(base, sid, args.wait)

    rows = attrs_for_session(sid, Path(args.spans_dir))
    print_usage_rows(rows)

    summary_rows = summarization_cache_rows(rows)
    if not summary_rows:
        print(
            "ERROR: no summarization usage span with input tokens found",
            file=sys.stderr,
        )
        return 1

    best = max(ratio for _, _, ratio in summary_rows)
    print(f"best_summarization_cache_ratio={best:.4f}")
    if args.min_cache_ratio is not None and best < args.min_cache_ratio:
        print(
            f"ERROR: best summarization cache ratio {best:.4f} < "
            f"required {args.min_cache_ratio:.4f}",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--turns", type=int, default=6)
    parser.add_argument("--wait", type=int, default=180)
    parser.add_argument("--session-id")
    parser.add_argument(
        "--model", help="Optional model override, e.g. openai:gpt-4.1-mini"
    )
    parser.add_argument("--spans-dir", default=str(SPANS))
    parser.add_argument(
        "--min-cache-ratio",
        type=float,
        default=DEFAULT_MIN_CACHE_RATIO,
        help="Minimum live summarization cache/input ratio. Use 0 to only print.",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="No-server smoke: verify summarizer request prefix shape and skill inclusion.",
    )
    args = parser.parse_args()

    if args.direct:
        result = asyncio.run(run_direct())
        print("manual_cache_shape_ok")
        for key, value in result.items():
            print(f"{key}={value}")
        return

    raise SystemExit(run_live(args))


if __name__ == "__main__":
    main()
