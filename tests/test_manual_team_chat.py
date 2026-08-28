from manual import team_chat


class _Response:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {
            "session": {"messages": [{"role": "assistant", "content": "done"}]},
        }


def test_print_history_accepts_session_without_agent_name(monkeypatch, capsys):
    monkeypatch.setattr(team_chat.httpx, "get", lambda *args, **kwargs: _Response())

    team_chat.print_history("http://example.test/api", "session-1")

    output = capsys.readouterr().out
    assert "session: 1 msgs" in output
    assert "total: 1 msgs" in output
