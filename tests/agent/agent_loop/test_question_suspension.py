"""Loop-level behaviour of ``ask_user``.

The tool hands the turn to the user instead of returning a result, so the loop
has to treat it unlike every other tool:

* it runs **last** in a parallel batch, so its siblings' results are complete
  and persisted before the turn stops;
* multiple questions are supported across activations in a turn;
* the suspension is recorded on ``state.metadata`` rather than raised out of
  ``run()``, so the caller can park the agent in ``waiting_input`` instead of
  treating it as an error or an interrupt.
"""

from __future__ import annotations

import json
from typing import Annotated, AsyncIterator

from app.agent.agent_loop import Agent
from app.agent.errors import QuestionSuspended
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    FunctionCallDelta,
    HumanMessage,
    ToolCallDelta,
    ToolMessage,
)
from app.agent.schemas.agent import RunConfig
from app.agent.tools.registry import InjectedArg, Tool

from tests.agent.test_agent_run import make_tool_chunk

QUESTION_ID = "00000000-0000-0000-0000-0000000000aa"
SESSION_ID = "00000000-0000-0000-0000-0000000000bb"


def make_multi_tool_chunk(calls: list[tuple[str, str, str]]) -> ChatCompletionChunk:
    """One assistant message requesting several tool calls in parallel."""
    return ChatCompletionChunk(
        id="chunk-multi",
        created=1_000_000,
        model="mock-model",
        choices=[
            ChatCompletionChunkChoice(
                index=0,
                delta=ChatCompletionDelta(
                    tool_calls=[
                        ToolCallDelta(
                            index=index,
                            id=call_id,
                            function=FunctionCallDelta(name=name, arguments=arguments),
                        )
                        for index, (name, call_id, arguments) in enumerate(calls)
                    ]
                ),
                finish_reason="tool_calls",
            )
        ],
    )


class ScriptedProvider(LLMProviderBase):
    model = "mock-model"

    def __init__(self, responses: list[list[ChatCompletionChunk]]):
        super().__init__()
        self._responses = iter(responses)
        self.call_count = 0

    def stream(
        self, messages, tools=None, **kwargs
    ) -> AsyncIterator[ChatCompletionChunk]:
        self.call_count += 1
        chunks = next(self._responses)

        async def _gen() -> AsyncIterator[ChatCompletionChunk]:
            for chunk in chunks:
                yield chunk

        return _gen()

    async def chat(self, messages, tools=None, **kwargs) -> AssistantMessage:
        return AssistantMessage(content="mock")


def _ask_tool(order: list[str], captured: list[dict]) -> Tool:
    """Stand-in for the real tool: records its args, then suspends."""
    import uuid

    async def ask_user(
        questions: list,
        _tool_call_id: Annotated[str | None, InjectedArg()] = None,
    ) -> str:
        """Ask the user and suspend."""
        order.append("ask")
        captured.append({"questions": questions, "tool_call_id": _tool_call_id})
        raise QuestionSuspended(
            question_id=uuid.UUID(QUESTION_ID), session_id=uuid.UUID(SESSION_ID)
        )

    return Tool(ask_user, name="ask_user")


def _slow_tool(order: list[str]) -> Tool:
    async def read(path: str = "x") -> str:
        """Ordinary sibling tool."""
        order.append("read")
        return "file contents"

    return Tool(read, name="read")


ONE_QUESTION = json.dumps(
    {
        "questions": [
            {"question": "Which one?", "header": "Pick", "options": [{"label": "a"}]}
        ]
    }
)
OTHER_QUESTION = json.dumps(
    {
        "questions": [
            {"question": "And this?", "header": "Also", "options": [{"label": "b"}]}
        ]
    }
)


async def test_ask_runs_after_its_siblings_even_when_listed_first():
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [
            [
                make_multi_tool_chunk(
                    [
                        ("ask_user", "call-ask", ONE_QUESTION),
                        ("read", "call-read", '{"path": "a.py"}'),
                    ]
                )
            ]
        ]
    )
    agent = Agent(name="lead", llm_provider=provider)

    await agent.run(
        [HumanMessage(content="go")],
        injected_tools=[_ask_tool(order, captured), _slow_tool(order)],
    )

    assert order == ["read", "ask"]


async def test_sibling_results_are_kept_when_the_turn_suspends():
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [
            [
                make_multi_tool_chunk(
                    [
                        ("read", "call-read", '{"path": "a.py"}'),
                        ("ask_user", "call-ask", ONE_QUESTION),
                    ]
                )
            ]
        ]
    )
    agent = Agent(name="lead", llm_provider=provider)

    msgs = await agent.run(
        [HumanMessage(content="go")],
        injected_tools=[_ask_tool(order, captured), _slow_tool(order)],
    )

    results = {m.tool_call_id: m.content for m in msgs if isinstance(m, ToolMessage)}
    assert results["call-read"] == "file contents"
    # No further model call — the turn stopped at the question.
    assert provider.call_count == 1


async def test_suspension_is_reported_on_state_metadata():
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [[make_tool_chunk("ask_user", "call-ask", ONE_QUESTION)]]
    )
    agent = Agent(name="lead", llm_provider=provider)
    config = RunConfig(session_id=SESSION_ID)

    await agent.run(
        [HumanMessage(content="go")],
        config=config,
        injected_tools=[_ask_tool(order, captured)],
    )

    suspended = config.metadata.get("question_suspended")
    assert suspended is not None
    assert str(suspended["question_id"]) == QUESTION_ID
    assert suspended["tool_call_id"] == "call-ask"


async def test_tool_call_id_is_injected_into_the_tool():
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [[make_tool_chunk("ask_user", "call-ask", ONE_QUESTION)]]
    )
    agent = Agent(name="lead", llm_provider=provider)

    await agent.run(
        [HumanMessage(content="go")], injected_tools=[_ask_tool(order, captured)]
    )

    assert captured[0]["tool_call_id"] == "call-ask"


async def test_two_asks_in_one_batch_merge_into_a_single_question_set():
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [
            [
                make_multi_tool_chunk(
                    [
                        ("ask_user", "call-a", ONE_QUESTION),
                        ("ask_user", "call-b", OTHER_QUESTION),
                    ]
                )
            ]
        ]
    )
    agent = Agent(name="lead", llm_provider=provider)

    await agent.run(
        [HumanMessage(content="go")], injected_tools=[_ask_tool(order, captured)]
    )

    assert order == ["ask"]  # executed once, not twice
    headers = [question["header"] for question in captured[0]["questions"]]
    assert headers == ["Pick", "Also"]


async def test_a_resumed_activation_may_ask_again():
    """Multi-question turns: a resumed activation can ask again."""
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [
            [make_tool_chunk("ask_user", "call-ask-2", OTHER_QUESTION)],
        ]
    )
    agent = Agent(name="lead", llm_provider=provider)
    config = RunConfig(session_id=SESSION_ID, metadata={"question_resume": True})

    await agent.run(
        [HumanMessage(content="go")],
        config=config,
        injected_tools=[_ask_tool(order, captured)],
    )

    assert order == ["ask"]
    suspended = config.metadata.get("question_suspended")
    assert suspended is not None
    assert str(suspended["question_id"]) == QUESTION_ID
    assert suspended["tool_call_id"] == "call-ask-2"
    assert provider.call_count == 1


async def test_asking_again_in_resumed_turn_suspends_again():
    """Tools in a resumed turn run normally and a subsequent ask suspends."""
    order: list[str] = []
    captured: list[dict] = []
    provider = ScriptedProvider(
        [
            [make_tool_chunk("read", "call-read", '{"path": "a.py"}')],
            [make_tool_chunk("ask_user", "call-ask-2", OTHER_QUESTION)],
        ]
    )
    agent = Agent(name="lead", llm_provider=provider)
    config = RunConfig(session_id=SESSION_ID, metadata={"question_resume": True})

    await agent.run(
        [HumanMessage(content="go")],
        config=config,
        injected_tools=[_ask_tool(order, captured), _slow_tool(order)],
    )
    assert order == ["read", "ask"]
    suspended = config.metadata.get("question_suspended")
    assert suspended is not None
    assert str(suspended["question_id"]) == QUESTION_ID
    assert suspended["tool_call_id"] == "call-ask-2"
    assert provider.call_count == 2
