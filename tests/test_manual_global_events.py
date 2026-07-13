from manual.global_events import format_event, missing_expected


def test_format_event_summarizes_global_event_payloads():
    assert (
        format_event(
            "session_turn_started",
            {
                "session_id": "session-123",
                "source": "scheduled_task",
                "task_name": "Daily",
            },
        )
        == "session=session-123 source=scheduled_task task=Daily"
    )
    assert (
        format_event(
            "title_update",
            {"session_id": "session-123", "title": "Generated title"},
        )
        == "session=session-123 title='Generated title'"
    )


def test_missing_expected_reports_events_not_observed():
    events = [
        {"event": "title_update", "data": {"session_id": "session-123"}},
        {"event": "desktop_notification", "data": {"kind": "assistant_done"}},
    ]

    assert missing_expected(events, ["title_update", "session_turn_started"]) == [
        "session_turn_started"
    ]
