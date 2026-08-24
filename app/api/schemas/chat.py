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
    workspace: str = Field(..., min_length=1, description="Workspace directory.")
    model: str | None = Field(None, description="Per-session lead model override.")
    thinking_level: str | None = Field(
        None, description="Per-session lead thinking level override."
    )
    fast_mode: bool = Field(
        False,
        description="Per-request fast mode. Ignored by unsupported providers.",
    )
    mentions: list[str] | None = Field(
        None, description="Paths of files/folders mentioned in this prompt."
    )

    @classmethod
    def as_form(
        cls,
        message: str | None = Form(None),
        session_id: str | None = Form(None),
        interrupt: bool = Form(False),
        workspace: str = Form(...),
        model: str | None = Form(None),
        thinking_level: str | None = Form(None),
        fast_mode: bool = Form(False),
        mentions: str | None = Form(None),
    ) -> "ChatForm":
        parsed_mentions = None
        if mentions:
            try:
                import json

                parsed_mentions = json.loads(mentions)
                if not isinstance(parsed_mentions, list):
                    raise ValueError("mentions must be a list of strings.")
            except Exception as exc:
                raise HTTPException(
                    status_code=422, detail="Invalid JSON for mentions."
                ) from exc
        try:
            return cls(
                message=message,
                session_id=session_id,
                interrupt=interrupt,
                workspace=workspace,
                model=model,
                thinking_level=thinking_level,
                fast_mode=fast_mode,
                mentions=parsed_mentions,
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
        if (
            self.model is not None
            and self.model.strip()
            and ":" not in self.model.strip()
        ):
            raise ValueError("model must use 'provider:model' format.")
        return self
