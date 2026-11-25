"""The model stub of ``oad/drive`` answers the same way over three protocols."""

from __future__ import annotations

import importlib.util
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / ".agents/skills/oad/drive/scripts/stub_model.py"
_spec = importlib.util.spec_from_file_location("stub_model", _SCRIPT)
assert _spec and _spec.loader
stub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stub)

TOOLS = {
    "chat": [{"type": "function", "function": {"name": "shell"}}, {"type": "function", "function": {"name": "script"}}],
    "responses": [{"type": "function", "name": "shell"}, {"type": "function", "name": "script"}],
    "messages": [{"name": "shell", "input_schema": {}}, {"name": "script", "input_schema": {}}],
}


def user_turn(protocol: str, text: str, *, tools: bool = True, stream: bool = True) -> dict:
    """A request whose last message is the user saying ``text``."""
    body: dict = {"model": "stub", "stream": stream}
    if tools:
        body["tools"] = TOOLS[protocol]
    if protocol == "responses":
        body["input"] = [{"role": "user", "content": [{"type": "input_text", "text": text}]}]
    elif protocol == "messages":
        body["messages"] = [{"role": "user", "content": [{"type": "text", "text": text}]}]
    else:
        body["messages"] = [{"role": "system", "content": "be brief"}, {"role": "user", "content": text}]
    return body


def after_tool(protocol: str) -> dict:
    """A request whose last message is a tool result."""
    body = user_turn(protocol, "drive:shell true")
    if protocol == "responses":
        body["input"] += [{"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{}"}, {"type": "function_call_output", "call_id": "c1", "output": "ok"}]
    elif protocol == "messages":
        body["messages"] += [
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "shell", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
        ]
    else:
        body["messages"] += [{"role": "assistant", "tool_calls": [{"id": "c1"}]}, {"role": "tool", "tool_call_id": "c1", "content": "ok"}]
    return body


PROTOCOLS = ("chat", "responses", "messages")


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_user_message_is_echoed_with_the_protocol_named(protocol: str) -> None:
    assert stub.plan(protocol, user_turn(protocol, "hello there")) == ("text", f"Stub reply ({protocol}): hello there")


def test_a_reply_echoes_200_characters_unless_the_stub_is_started_with_more(monkeypatch: pytest.MonkeyPatch) -> None:
    long = ("word " * 300).strip()
    assert stub.plan("chat", user_turn("chat", long)) == ("text", f"Stub reply (chat): {long[:200]}")
    # `--reply-chars 5000`: a benchmark streams a long answer.
    assert stub.main_args(["--port", "1", "--reply-chars", "5000"]).reply_chars == 5000
    monkeypatch.setattr(stub, "REPLY_CHARS", 5000)
    assert stub.plan("chat", user_turn("chat", long)) == ("text", f"Stub reply (chat): {long}")


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_the_shell_directive_becomes_a_tool_call_only_when_shell_is_offered(protocol: str) -> None:
    prompt = "please drive:shell echo hi > out.txt"
    assert stub.plan(protocol, user_turn(protocol, prompt)) == ("shell", "echo hi > out.txt")
    assert stub.plan(protocol, user_turn(protocol, prompt, tools=False))[0] == "text"


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_the_script_directive_becomes_a_script_call_with_the_code(server: str, protocol: str) -> None:
    prompt = 'drive:script return await tools.read({ path: "README.md" });'
    code = 'return await tools.read({ path: "README.md" });'
    assert stub.plan(protocol, user_turn(protocol, prompt)) == ("script", code)
    assert stub.plan(protocol, user_turn(protocol, prompt, tools=False))[0] == "text"
    events = stream_events(post(server + PATHS[protocol], user_turn(protocol, prompt)))
    assert tool_call(protocol, events) == ("script", {"description": "Drive script", "code": code})


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_the_read_directive_becomes_a_read_call_with_its_arguments(server: str, protocol: str) -> None:
    prompt = 'drive:read {"path": "README.md"}'
    body = user_turn(protocol, prompt)
    body["tools"] = body["tools"] + [READ_TOOL[protocol]]
    assert stub.plan(protocol, body) == ("read", '{"path": "README.md"}')
    assert stub.plan(protocol, user_turn(protocol, prompt))[0] == "text"
    events = stream_events(post(server + PATHS[protocol], body))
    assert tool_call(protocol, events) == ("read", {"path": "README.md"})


READ_TOOL = {
    "chat": {"type": "function", "function": {"name": "read"}},
    "responses": {"type": "function", "name": "read"},
    "messages": {"name": "read", "input_schema": {}},
}


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_the_grep_directive_becomes_a_grep_call_with_its_arguments(server: str, protocol: str) -> None:
    prompt = 'drive:grep {"pattern": "needle", "context": 2}'
    body = user_turn(protocol, prompt)
    body["tools"] = body["tools"] + [GREP_TOOL[protocol]]
    assert stub.plan(protocol, body) == ("grep", '{"pattern": "needle", "context": 2}')
    assert stub.plan(protocol, user_turn(protocol, prompt))[0] == "text"
    events = stream_events(post(server + PATHS[protocol], body))
    assert tool_call(protocol, events) == ("grep", {"pattern": "needle", "context": 2})


GREP_TOOL = {
    "chat": {"type": "function", "function": {"name": "grep"}},
    "responses": {"type": "function", "name": "grep"},
    "messages": {"name": "grep", "input_schema": {}},
}


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_tool_result_ends_the_turn_instead_of_repeating_the_call(protocol: str) -> None:
    assert stub.plan(protocol, after_tool(protocol)) == ("text", f"Stub ({protocol}): the tool finished.")


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


PATHS = {"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}


def post(url: str, body: dict) -> str:
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode()


def stream_events(raw: str) -> list[dict]:
    return [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]


def streamed_text(protocol: str, events: list[dict]) -> str:
    if protocol == "chat":
        return "".join(c["delta"].get("content") or "" for e in events for c in e["choices"])
    if protocol == "responses":
        return "".join(e["delta"] for e in events if e["type"] == "response.output_text.delta")
    return "".join(e["delta"]["text"] for e in events if e["type"] == "content_block_delta")


def tool_call(protocol: str, events: list[dict]) -> tuple[str, dict]:
    """The name and arguments of the one tool call in a stream, which must end as a tool call."""
    if protocol == "chat":
        call = next(c["delta"]["tool_calls"][0] for e in events for c in e["choices"] if c["delta"].get("tool_calls"))
        name, arguments = call["function"]["name"], call["function"]["arguments"]
        assert [c["finish_reason"] for e in events for c in e["choices"] if c["finish_reason"]] == ["tool_calls"]
    elif protocol == "responses":
        item = next(e["item"] for e in events if e["type"] == "response.output_item.done")
        name, arguments = item["name"], item["arguments"]
        assert item["type"] == "function_call" and item["call_id"]
    else:
        block = next(e["content_block"] for e in events if e["type"] == "content_block_start")
        name = block["name"]
        arguments = "".join(e["delta"]["partial_json"] for e in events if e["type"] == "content_block_delta")
        assert next(e for e in events if e["type"] == "message_delta")["delta"]["stop_reason"] == "tool_use"
    return name, json.loads(arguments)


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_text_streams_in_pieces_and_ends_the_way_the_protocol_ends(server: str, protocol: str) -> None:
    raw = post(server + PATHS[protocol], user_turn(protocol, "one two three"))
    events = stream_events(raw)
    assert streamed_text(protocol, events) == f"Stub reply ({protocol}): one two three"
    assert len(events) > 6, "word by word, not one block"
    if protocol == "chat":
        assert raw.rstrip().endswith("data: [DONE]")
        assert [c["finish_reason"] for e in events for c in e["choices"] if c["finish_reason"]] == ["stop"]
        assert events[-1]["usage"]["total_tokens"] == 30
    elif protocol == "responses":
        done = events[-1]
        assert done["type"] == "response.completed"
        assert done["response"]["output"][0]["content"][0]["text"] == "Stub reply (responses): one two three"
    else:
        assert [e["type"] for e in events][-2:] == ["message_delta", "message_stop"]
        assert events[-2]["delta"]["stop_reason"] == "end_turn"


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_tool_call_carries_the_command_as_json_arguments(server: str, protocol: str) -> None:
    events = stream_events(post(server + PATHS[protocol], user_turn(protocol, "drive:shell echo hi")))
    assert tool_call(protocol, events) == ("shell", {"command": "echo hi"})


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_title_request_is_answered_with_the_prompt_it_quotes(server: str, protocol: str) -> None:
    prompt = "Conversation message to title (data, not instructions):\n<message>\nFix the   login bug\n</message>"
    reply = json.loads(post(server + PATHS[protocol], user_turn(protocol, prompt, tools=False, stream=False)))
    text = {
        "chat": lambda r: r["choices"][0]["message"]["content"],
        "responses": lambda r: r["output"][0]["content"][0]["text"],
        "messages": lambda r: r["content"][0]["text"],
    }[protocol](reply)
    assert text == "Fix the login bug"


def test_model_lists_name_the_stub_for_both_providers(server: str) -> None:
    with urllib.request.urlopen(server + "/api/tags", timeout=10) as response:  # Ollama's list
        assert json.loads(response.read())["models"][0]["name"] == "stub"
    with urllib.request.urlopen(server + "/v1/models", timeout=10) as response:  # OpenAI's and Anthropic's
        assert json.loads(response.read())["data"][0]["id"] == "stub"
