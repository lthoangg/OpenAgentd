"""
Manual scenario tests for max_tokens/length truncation and recovery.
Run with: uv run python tests/manual/truncation_scenarios.py
"""

import asyncio
import sys

from app.agent.agent_loop.core import Agent
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    HumanMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ToolCallDelta,
    FunctionCallDelta,
)
from app.agent.tools.registry import Tool

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results = []


def check(label, got, expected):
    ok = got == expected
    sym = PASS if ok else FAIL
    results.append((sym, label))
    if ok:
        print(f"  {sym}  {label}")
    else:
        print(f"  {sym}  {label}")
        print(f"       got:      {got!r}")
        print(f"       expected: {expected!r}")


class SimpleMockProvider(LLMProviderBase):
    def __init__(self, responses):
        super().__init__()
        self.model = "mock-model"
        self.responses = list(responses)
        self.call_count = 0

    async def chat(self, messages, tools, model_kwargs=None):
        pass

    async def stream(self, messages, tools, model_kwargs=None):
        if self.call_count >= len(self.responses):
            yield ChatCompletionChunk(
                id="done",
                created=0,
                model=self.model,
                choices=[
                    ChatCompletionChunkChoice(
                        index=0,
                        delta=ChatCompletionDelta(content="No more mock responses."),
                        finish_reason="stop",
                    )
                ],
            )
            return

        chunks = self.responses[self.call_count]
        self.call_count += 1
        for chunk in chunks:
            yield chunk


async def run():
    # ── Scenario A: Tool call truncated by max_tokens ──
    print("\n── Scenario A: Tool call truncated by max_tokens ──")

    truncated_tool_chunk = ChatCompletionChunk(
        id="c1",
        created=0,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_1",
                            function=FunctionCallDelta(
                                name="write_file",
                                arguments='{"content": "very long content that gets cut off',
                            ),
                        )
                    ]
                ),
                finish_reason="max_tokens",
            )
        ],
    )

    recovery_chunk = ChatCompletionChunk(
        id="c2",
        created=0,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content="I will write it in chunks instead."),
                finish_reason="stop",
            )
        ],
    )

    def write_file(content: str) -> str:
        return "written"

    provider = SimpleMockProvider([[truncated_tool_chunk], [recovery_chunk]])
    agent = Agent(name="bot", llm_provider=provider, tools=[Tool(write_file)])

    msgs = await agent.run([HumanMessage(content="write file")])

    check("A1: 4 messages in total", len(msgs), 4)
    check("A2: First is user message", isinstance(msgs[0], HumanMessage), True)
    check(
        "A3: Second is truncated assistant message",
        isinstance(msgs[1], AssistantMessage),
        True,
    )
    check(
        "A4: Third is injected recovery HumanMessage",
        isinstance(msgs[2], HumanMessage),
        True,
    )
    check(
        "A5: Injected message is hidden from user",
        msgs[2].extra == {"hidden_from_user": True},
        True,
    )
    check(
        "A6: Recovery prompt mentions truncation",
        "truncated and could not be executed" in msgs[2].content,
        True,
    )
    check(
        "A7: Fourth is recovered assistant message",
        msgs[3].content,
        "I will write it in chunks instead.",
    )

    # ── Scenario B: Text response truncated by max_tokens ──
    print("\n── Scenario B: Text response truncated by max_tokens ──")

    truncated_text_chunk = ChatCompletionChunk(
        id="c1",
        created=0,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    content="This is a long response that got cut off "
                ),
                finish_reason="max_tokens",
            )
        ],
    )

    recovery_text_chunk = ChatCompletionChunk(
        id="c2",
        created=0,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(content="and here is the rest of the text."),
                finish_reason="stop",
            )
        ],
    )

    provider = SimpleMockProvider([[truncated_text_chunk], [recovery_text_chunk]])
    agent = Agent(name="bot", llm_provider=provider, tools=[])

    msgs = await agent.run([HumanMessage(content="explain something long")])

    check("B1: 4 messages in total", len(msgs), 4)
    check("B2: First is user message", isinstance(msgs[0], HumanMessage), True)
    check(
        "B3: Second is truncated assistant message",
        msgs[1].content,
        "This is a long response that got cut off ",
    )
    check(
        "B4: Third is injected recovery HumanMessage",
        isinstance(msgs[2], HumanMessage),
        True,
    )
    check(
        "B5: Injected message is hidden from user",
        msgs[2].extra == {"hidden_from_user": True},
        True,
    )
    check(
        "B6: Recovery prompt mentions response cut off",
        "response was cut off because you exceeded the maximum" in msgs[2].content,
        True,
    )
    check(
        "B7: Fourth is recovered assistant message",
        msgs[3].content,
        "and here is the rest of the text.",
    )

    # ── Summary ────────────────────────────────────────────────────────────
    print("\n" + "═" * 60)
    passed = sum(1 for s, _ in results if s == PASS)
    failed = sum(1 for s, _ in results if s == FAIL)
    print(f"  Results: {passed} passed, {failed} failed  (total {len(results)})")
    print("═" * 60)
    return failed


async def main():
    failed = await run()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
