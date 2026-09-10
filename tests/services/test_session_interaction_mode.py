from __future__ import annotations

import pytest

from app.services.chat_service import (
    create_chat_session,
    get_messages,
    get_messages_for_llm,
)
from app.services.session_interaction_mode import (
    ensure_session_interaction_mode_prompt,
    set_session_interaction_mode,
)


@pytest.mark.asyncio
async def test_default_code_mode_does_not_inject_synthetic_prompt():
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        session = await create_chat_session(db, workspace="/workspace")
        await db.commit()

        appended = await ensure_session_interaction_mode_prompt(db, session.id, "code")
        await db.commit()

        assert appended is False
        llm_messages = await get_messages_for_llm(db, session.id)
        assert llm_messages == []


@pytest.mark.asyncio
async def test_switching_to_plan_appends_one_hidden_control_message():
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        session = await create_chat_session(db, workspace="/workspace")
        await db.commit()

        updated, changed = await set_session_interaction_mode(db, session.id, "plan")
        await db.commit()

        assert changed is True
        assert updated.interaction_mode == "plan"
        assert [message.content for message in await get_messages(db, session.id)] == []

        llm_messages = await get_messages_for_llm(db, session.id)
        assert len(llm_messages) == 1
        assert llm_messages[0].role == "user"
        assert llm_messages[0].extra == {
            "hidden_from_user": True,
            "interaction_mode": "plan",
            "interaction_mode_transition": True,
            "interaction_mode_prompt": True,
        }
        assert "Plan mode" in (llm_messages[0].content or "")
        assert "<proposed_plan>" in (llm_messages[0].content or "")


@pytest.mark.asyncio
async def test_selecting_the_current_mode_does_not_append_another_control_message():
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        session = await create_chat_session(db, workspace="/workspace")
        await db.commit()

        await set_session_interaction_mode(db, session.id, "plan")
        await db.commit()
        updated, changed = await set_session_interaction_mode(db, session.id, "plan")
        await db.commit()

        assert changed is False
        assert updated.interaction_mode == "plan"
        assert len(await get_messages_for_llm(db, session.id)) == 1


@pytest.mark.asyncio
async def test_switching_back_to_code_appends_one_hidden_control_message():
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        session = await create_chat_session(db, workspace="/workspace")
        await db.commit()

        await set_session_interaction_mode(db, session.id, "plan")
        await db.commit()
        updated, changed = await set_session_interaction_mode(db, session.id, "code")
        await db.commit()

        assert changed is True
        assert updated.interaction_mode == "code"

        llm_messages = await get_messages_for_llm(db, session.id)
        assert len(llm_messages) == 2
        assert llm_messages[0].extra["interaction_mode"] == "plan"
        assert llm_messages[1].role == "user"
        assert llm_messages[1].extra == {
            "hidden_from_user": True,
            "interaction_mode": "code",
            "interaction_mode_transition": True,
            "interaction_mode_prompt": True,
        }
        assert "Code mode" in (llm_messages[1].content or "")
        assert "appropriate verification" in (llm_messages[1].content or "")


@pytest.mark.asyncio
async def test_plan_mode_ensures_prompt_if_missing():
    from app.core.db import async_session_factory

    async with async_session_factory() as db:
        session = await create_chat_session(db, workspace="/workspace")
        session.interaction_mode = "plan"
        db.add(session)
        await db.commit()

        appended = await ensure_session_interaction_mode_prompt(db, session.id, "plan")
        await db.commit()

        assert appended is True
        llm_messages = await get_messages_for_llm(db, session.id)
        assert len(llm_messages) == 1
        assert llm_messages[0].extra["interaction_mode"] == "plan"
        assert (
            await ensure_session_interaction_mode_prompt(db, session.id, "plan")
        ) is False
