from app.models.chat import ChatSession


def test_chat_session_recent_list_indexes_cover_mode_and_workspace() -> None:
    indexes = {
        index.name: tuple(column.name for column in index.columns)
        for index in ChatSession.__table__.indexes
    }

    assert indexes["ix_chat_sessions_top_mode_created"] == (
        "parent_session_id",
        "mode",
        "created_at",
    )
    assert indexes["ix_chat_sessions_top_mode_workspace_created"] == (
        "parent_session_id",
        "mode",
        "workspace",
        "created_at",
    )
