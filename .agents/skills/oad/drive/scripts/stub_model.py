#!/usr/bin/env python3
"""A scripted stand-in for a model, speaking the three wire protocols the
backend uses, so a journey costs nothing and gets the same answer every run.

    stub_model.py --port 8792 --log /tmp/oad-drive/model.jsonl

| Path                     | Protocol                 | Reached through                         |
|--------------------------|--------------------------|-----------------------------------------|
| `/v1/chat/completions`   | OpenAI Chat Completions  | `ollama:stub` (`OLLAMA_BASE_URL`)       |
| `/v1/responses`          | OpenAI Responses         | `ollama:stub` with `responses_api: true`|
| `/v1/messages`           | Anthropic Messages       | `anthropic:stub` (`ANTHROPIC_BASE_URL`) |

What it answers is the same in every protocol, decided by the request's last
message:

- a tool result: ``Stub (<protocol>): the tool finished.``
- a user message holding ``drive:shell <command>``: one ``shell`` tool call
  with that command (only when the request offers a ``shell`` tool)
- a user message holding ``drive:script <code>``: one ``script`` tool call
  that runs that code, described as ``Drive script`` (only when the request
  offers a ``script`` tool)
- a user message holding ``drive:preview <JSON arguments>``: one ``preview``
  tool call with those arguments, e.g. ``{"action": "open", "path": "a.html"}``
  (only when the request offers a ``preview`` tool)
- any other user message: ``Stub reply (<protocol>): <the message>``, streamed
  word by word
- a request without ``stream``: the title request's own ``<message>`` text,
  cut to 40 characters, so each session is titled after its first prompt;
  ``Drive session`` for any other such request

``<protocol>`` is ``chat``, ``responses`` or ``messages``, so a transcript
shows which protocol carried the turn. Every request is appended to ``--log``
as one JSON line.
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MODEL = "stub"
# A directive names the tool to call; the rest of its line is the tool's input.
DIRECTIVE = re.compile(r"drive:(shell|script|preview)\s+(.+)")
TITLE_MESSAGE = re.compile(r"<message>\s*(.*?)\s*</message>", re.S)
# Each tool call gets its own id, so a session with several calls can read
# each result back by id (`/agent/<session>/tool-results/<id>`).
_CALLS = itertools.count(1)


def next_call_id(prefix: str = "call_drive") -> str:
    return f"{prefix}_{next(_CALLS)}"


def _text(content: Any) -> str:
    """The text of a message's content, whichever protocol wrote it."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def read_request(protocol: str, body: dict[str, Any]) -> tuple[bool, str, set[str]]:
    """``(ends with a tool result, last user text, offered tool names)``."""
    tools: list[Any] = body.get("tools") or []
    messages: list[Any]
    if protocol == "chat":
        messages = body.get("messages") or []
        after_tool = bool(messages) and messages[-1].get("role") == "tool"
        offered = {t.get("function", {}).get("name") for t in tools}
    elif protocol == "responses":
        messages = body.get("input") if isinstance(body.get("input"), list) else [{"role": "user", "content": body.get("input")}]
        after_tool = bool(messages) and messages[-1].get("type") == "function_call_output"
        offered = {t.get("name") for t in tools}
    else:  # messages
        messages = body.get("messages") or []
        last = messages[-1].get("content") if messages else None
        after_tool = isinstance(last, list) and any(isinstance(p, dict) and p.get("type") == "tool_result" for p in last)
        offered = {t.get("name") for t in tools}
    user = next((_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user" and _text(m.get("content"))), "")
    return after_tool, user, {name for name in offered if name}


def plan(protocol: str, body: dict[str, Any]) -> tuple[str, str]:
    """What to answer: ``("text", reply)``, or the tool to call and its input."""
    after_tool, user, offered = read_request(protocol, body)
    if after_tool:
        return "text", f"Stub ({protocol}): the tool finished."
    directive = DIRECTIVE.search(user)
    if directive and directive.group(1) in offered:
        return directive.group(1), directive.group(2).strip()
    return "text", f"Stub reply ({protocol}): {user.strip()[:200]}"


def tool_arguments(kind: str, value: str) -> str:
    """The JSON arguments of the tool call a directive asks for."""
    if kind == "preview":
        return json.dumps(json.loads(value))
    return json.dumps({"command": value} if kind == "shell" else {"description": "Drive script", "code": value})


def pieces(text: str) -> list[str]:
    words = text.split(" ")
    return [word + (" " if i < len(words) - 1 else "") for i, word in enumerate(words)]


# ── One event list per protocol ──────────────────────────────────────────────
# Each entry is (SSE event name or None, JSON payload).


def chat_events(kind: str, value: str) -> list[tuple[str | None, dict]]:
    def chunk(delta: dict, finish: str | None = None) -> dict:
        choice = {"index": 0, "delta": delta, "finish_reason": finish}
        return {"id": "stub-1", "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL, "choices": [choice]}

    events = [chunk({"role": "assistant", "content": ""})]
    if kind != "text":
        call = {"index": 0, "id": next_call_id(), "type": "function", "function": {"name": kind, "arguments": tool_arguments(kind, value)}}
        events += [chunk({"tool_calls": [call]}), chunk({}, "tool_calls")]
    else:
        events += [chunk({"content": piece}) for piece in pieces(value)]
        events.append(chunk({}, "stop"))
    usage = {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    events.append({"id": "stub-1", "object": "chat.completion.chunk", "model": MODEL, "choices": [], "usage": usage})
    return [(None, event) for event in events]


def responses_events(kind: str, value: str) -> list[tuple[str | None, dict]]:
    events: list[dict] = [{"type": "response.created", "response": {"id": "resp_stub_1", "status": "in_progress"}}]
    if kind != "text":
        arguments = tool_arguments(kind, value)
        item = {"type": "function_call", "id": "fc_stub_1", "call_id": next_call_id(), "name": kind, "arguments": ""}
        events += [
            {"type": "response.output_item.added", "output_index": 0, "item": item},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_stub_1", "output_index": 0, "delta": arguments},
            {"type": "response.function_call_arguments.done", "item_id": "fc_stub_1", "output_index": 0, "arguments": arguments},
        ]
        done = {**item, "arguments": arguments, "status": "completed"}
    else:
        item = {"type": "message", "id": "msg_stub_1", "role": "assistant", "content": []}
        events.append({"type": "response.output_item.added", "output_index": 0, "item": item})
        events += [{"type": "response.output_text.delta", "item_id": "msg_stub_1", "output_index": 0, "content_index": 0, "delta": piece} for piece in pieces(value)]
        events.append({"type": "response.output_text.done", "item_id": "msg_stub_1", "output_index": 0, "content_index": 0, "text": value})
        done = {**item, "status": "completed", "content": [{"type": "output_text", "text": value, "annotations": []}]}
    events.append({"type": "response.output_item.done", "output_index": 0, "item": done})
    usage = {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}
    events.append({"type": "response.completed", "response": {"id": "resp_stub_1", "status": "completed", "model": MODEL, "output": [done], "usage": usage}})
    return [(event["type"], event) for event in events]


def messages_events(kind: str, value: str) -> list[tuple[str | None, dict]]:
    message = {"id": "msg_stub_1", "type": "message", "role": "assistant", "model": MODEL, "content": [], "stop_reason": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
    events: list[dict] = [{"type": "message_start", "message": message}]
    if kind != "text":
        block = {"type": "tool_use", "id": next_call_id("toolu_drive"), "name": kind, "input": {}}
        deltas = [{"type": "input_json_delta", "partial_json": tool_arguments(kind, value)}]
        stop = "tool_use"
    else:
        block = {"type": "text", "text": ""}
        deltas = [{"type": "text_delta", "text": piece} for piece in pieces(value)]
        stop = "end_turn"
    events.append({"type": "content_block_start", "index": 0, "content_block": block})
    events += [{"type": "content_block_delta", "index": 0, "delta": delta} for delta in deltas]
    events += [
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 20}},
        {"type": "message_stop"},
    ]
    return [(event["type"], event) for event in events]


def whole_reply(protocol: str, body: dict[str, Any]) -> dict:
    """The answer to a request that does not stream."""
    asked = TITLE_MESSAGE.search(read_request(protocol, body)[1])
    title = " ".join(asked.group(1).split())[:40] if asked else "Drive session"
    if protocol == "chat":
        choice = {"index": 0, "message": {"role": "assistant", "content": title}, "finish_reason": "stop"}
        return {"id": "stub-1", "object": "chat.completion", "model": MODEL, "choices": [choice], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
    if protocol == "responses":
        item = {"type": "message", "id": "msg_stub_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": title, "annotations": []}]}
        return {"id": "resp_stub_1", "object": "response", "status": "completed", "model": MODEL, "output": [item], "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}
    return {"id": "msg_stub_1", "type": "message", "role": "assistant", "model": MODEL, "content": [{"type": "text", "text": title}], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 2}}


PROTOCOLS = {
    "/chat/completions": ("chat", chat_events),
    "/responses": ("responses", responses_events),
    "/messages": ("messages", messages_events),
}


class Handler(BaseHTTPRequestHandler):
    log_path: Path | None = None

    def log_message(self, format: str, *args: object) -> None:  # keep stdout for the caller's own log
        return

    def _json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (http.server's name)
        path = self.path.split("?", 1)[0].rstrip("/")
        if path.endswith("/api/tags"):
            self._json({"models": [{"name": MODEL, "model": MODEL}]})
        elif path.endswith("/models"):
            self._json({"object": "list", "data": [{"id": MODEL, "object": "model", "type": "model", "display_name": MODEL}]})
        else:
            self._json({"status": "ok"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        path = self.path.split("?", 1)[0].rstrip("/")
        match = next((entry for suffix, entry in PROTOCOLS.items() if path.endswith(suffix)), None)
        if match is None:
            self._json({"error": {"message": f"the stub does not speak {path}"}}, 404)
            return
        protocol, events_for = match
        kind, value = plan(protocol, body)
        if self.log_path:
            with self.log_path.open("a", encoding="utf-8") as log:
                log.write(json.dumps({"ts": time.time(), "protocol": protocol, "stream": bool(body.get("stream")), "answer": [kind, value], "request": body}) + "\n")
        if not body.get("stream"):
            self._json(whole_reply(protocol, body))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for name, event in events_for(kind, value):
                prefix = f"event: {name}\n" if name else ""
                self.wfile.write(f"{prefix}data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.02)  # the UI should see a stream, not one block
            if protocol != "messages":
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, help="append one JSON line per request")
    args = parser.parse_args()
    Handler.log_path = args.log
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
