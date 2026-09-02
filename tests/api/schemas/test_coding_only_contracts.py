import pytest
from pydantic import ValidationError

from app.api.schemas.chat import ChatForm
from app.api.schemas.sessions import AgentSessionResolveRequest
from app.scheduler.schemas import ScheduledTaskCreate


def test_chat_requires_workspace():
    with pytest.raises(ValidationError):
        ChatForm(message="hello")


def test_session_resolution_requires_workspace():
    with pytest.raises(ValidationError):
        AgentSessionResolveRequest()


def test_scheduler_requires_workspace_and_has_no_mode_contract():
    with pytest.raises(ValidationError):
        ScheduledTaskCreate(
            name="task", schedule_type="every", every_seconds=60, prompt="run"
        )
