from __future__ import annotations

from app.agent.agent_loop import Agent
from app.agent.schemas.agent import RunConfig
from app.agent.schemas.chat import HumanMessage, ToolMessage
from app.agent.tools.registry import Tool
from tests.agent.test_agent_run import MockProvider, make_text_chunk, make_tool_chunk


async def test_plan_mode_never_executes_a_mutating_tool():
    executed = False

    async def patch_workspace() -> str:
        nonlocal executed
        executed = True
        return "patched"

    provider = MockProvider(
        [
            [make_tool_chunk("patch", "call_patch", "{}")],
            [make_text_chunk("I will provide a plan instead.")],
        ]
    )
    agent = Agent(
        name="openagentd",
        llm_provider=provider,
        tools=[Tool(patch_workspace, name="patch")],
    )

    messages = await agent.run(
        [HumanMessage(content="Change the project")],
        config=RunConfig(metadata={"interaction_mode": "plan"}),
    )

    assert executed is False
    tool_result = next(
        message for message in messages if isinstance(message, ToolMessage)
    )
    assert tool_result.content == "Error: Tool 'patch' is unavailable in Plan mode."


async def test_plan_mode_allows_shell_tool():
    executed = False

    async def shell_command(command: str) -> str:
        nonlocal executed
        executed = True
        return "output"

    provider = MockProvider(
        [
            [make_tool_chunk("shell", "call_shell", '{"command": "pytest"}')],
            [make_text_chunk("Shell command executed.")],
        ]
    )
    agent = Agent(
        name="openagentd",
        llm_provider=provider,
        tools=[Tool(shell_command, name="shell")],
    )

    messages = await agent.run(
        [HumanMessage(content="Run test suite")],
        config=RunConfig(metadata={"interaction_mode": "plan"}),
    )

    assert executed is True
    tool_result = next(
        message for message in messages if isinstance(message, ToolMessage)
    )
    assert tool_result.content == "output"


async def test_plan_mode_allows_inspection_tools():
    executed = False

    async def read_file(path: str) -> str:
        nonlocal executed
        executed = True
        return "file contents"

    provider = MockProvider(
        [
            [make_tool_chunk("read", "call_read", '{"path": "file.py"}')],
            [make_text_chunk("File read successfully.")],
        ]
    )
    agent = Agent(
        name="openagentd",
        llm_provider=provider,
        tools=[Tool(read_file, name="read")],
    )

    messages = await agent.run(
        [HumanMessage(content="Inspect file.py")],
        config=RunConfig(metadata={"interaction_mode": "plan"}),
    )

    assert executed is True
    tool_result = next(
        message for message in messages if isinstance(message, ToolMessage)
    )
    assert tool_result.content == "file contents"


async def test_code_mode_allows_mutating_tools():
    executed = False

    async def patch_workspace() -> str:
        nonlocal executed
        executed = True
        return "applied patch"

    provider = MockProvider(
        [
            [make_tool_chunk("patch", "call_patch", "{}")],
            [make_text_chunk("Change complete.")],
        ]
    )
    agent = Agent(
        name="openagentd",
        llm_provider=provider,
        tools=[Tool(patch_workspace, name="patch")],
    )

    messages = await agent.run(
        [HumanMessage(content="Apply patch")],
        config=RunConfig(metadata={"interaction_mode": "code"}),
    )

    assert executed is True
    tool_result = next(
        message for message in messages if isinstance(message, ToolMessage)
    )
    assert tool_result.content == "applied patch"
