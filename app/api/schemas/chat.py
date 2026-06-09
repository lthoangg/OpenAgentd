"""Form bodies for POST /api/chat and POST /api/team/chat."""

from __future__ import annotations

from fastapi import Form, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from app.api.schemas.base import _validation_detail

# ── Form models (multipart/form-data) ────────────────────────────────────────
#
# FastAPI < 1.0 cannot combine ``Annotated[Model, Form()]`` with ``File()``
# in the same endpoint.  The ``as_form`` classmethod works around this by
# reading individual Form() fields and constructing the validated model
# via ``Depends(Model.as_form)``.


class ChatForm(BaseModel):
    """Validated form body for POST /api/chat and POST /api/team/chat.

    Modes (mutually exclusive):
    - **Normal send** (interrupt=false, message required)
    - **Interrupt** (interrupt=true, session_id required, no message)
    """

    message: str | None = Field(None, description="The user's message.")
    session_id: str | None = Field(
        None, description="Resume an existing session by UUID."
    )
    interrupt: bool = Field(
        False,
        description="Interrupt the running agent. Mutually exclusive with message.",
    )
    mode: str = Field("normal", description="Chat mode: normal or coding.")
    workspace: str | None = Field(
        None, description="Workspace directory for coding mode."
    )
    model: str | None = Field(None, description="Per-session lead model override.")
    thinking_level: str | None = Field(
        None, description="Per-session lead thinking level override."
    )
    fast_mode: bool = Field(
        False,
        description="Per-request fast mode. Ignored by unsupported providers.",
    )
    shell: bool = Field(
        False,
        description="Run message text as a shell command instead of an agent prompt.",
    )

    @classmethod
    def as_form(
        cls,
        message: str | None = Form(None),
        session_id: str | None = Form(None),
        interrupt: bool = Form(False),
        mode: str = Form("normal"),
        workspace: str | None = Form(None),
        model: str | None = Form(None),
        thinking_level: str | None = Form(None),
        fast_mode: bool = Form(False),
        shell: bool = Form(False),
    ) -> "ChatForm":
        try:
            return cls(
                message=message,
                session_id=session_id,
                interrupt=interrupt,
                mode=mode,
                workspace=workspace,
                model=model,
                thinking_level=thinking_level,
                fast_mode=fast_mode,
                shell=shell,
            )
        except ValidationError as exc:
            raise HTTPException(
                status_code=422, detail=_validation_detail(exc)
            ) from exc

    @model_validator(mode="after")
    def _validate_message_or_interrupt(self) -> "ChatForm":
        if self.interrupt and self.message:
            raise ValueError("interrupt and message are mutually exclusive.")
        if self.interrupt and not self.session_id:
            raise ValueError("session_id is required when interrupt=true.")
        if not self.interrupt and not self.message:
            raise ValueError("message is required when interrupt=false.")
        if self.message is not None and len(self.message.strip()) == 0:
            raise ValueError("message must not be blank.")
        if self.mode not in {"normal", "coding"}:
            raise ValueError("mode must be 'normal' or 'coding'.")
        if self.mode == "coding" and not self.workspace:
            raise ValueError("workspace is required when mode='coding'.")
        if (
            self.model is not None
            and self.model.strip()
            and ":" not in self.model.strip()
        ):
            raise ValueError("model must use 'provider:model' format.")
        if (
            self.thinking_level is not None
            and self.thinking_level.strip()
            and self.thinking_level.strip()
            not in {
                "none",
                "low",
                "medium",
                "high",
            }
        ):
            raise ValueError("thinking_level must be one of: none, low, medium, high.")
        return self
