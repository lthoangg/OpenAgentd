"""Tests for built-in /loop command parsing."""

from __future__ import annotations

from app.agent.mode.team.team import is_loop_command, parse_loop_command


def test_parse_loop_start_uses_text_after_space_as_prompt() -> None:
    command = parse_loop_command("/loop uv run pytest -q")

    assert command is not None
    assert command.action == "start"
    assert command.prompt == "uv run pytest -q"
    assert command.limit is None


def test_parse_loop_start_keeps_quotes_as_prompt_text() -> None:
    command = parse_loop_command('/loop "just say hi"')

    assert command is not None
    assert command.action == "start"
    assert command.prompt == '"just say hi"'


def test_parse_loop_start_accepts_unquoted_prompt_text() -> None:
    command = parse_loop_command("/loop just say hi")

    assert command is not None
    assert command.action == "start"
    assert command.prompt == "just say hi"


def test_parse_loop_set_accepts_supported_thresholds() -> None:
    command = parse_loop_command("/loop:set 20")

    assert command is not None
    assert command.action == "set"
    assert command.limit == 20


def test_parse_loop_set_rejects_unsupported_threshold() -> None:
    assert parse_loop_command("/loop:set 7") is None


def test_parse_loop_set_rejects_extra_arguments() -> None:
    assert parse_loop_command("/loop:set 10 now") is None


def test_parse_loop_rejects_unknown_subcommand() -> None:
    assert parse_loop_command("/loop:status") is None


def test_parse_loop_controls() -> None:
    assert parse_loop_command("/loop:pause") is not None
    assert parse_loop_command("/loop:resume") is not None
    assert parse_loop_command("/loop:stop") is not None


def test_is_loop_command_matches_loop_namespace_and_prompt_form() -> None:
    assert is_loop_command('/loop "prompt"')
    assert is_loop_command("/loop:pause")
    assert not is_loop_command("/init")
