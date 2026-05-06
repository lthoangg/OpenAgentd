"""Request and response schemas for ``/api/speech`` endpoints."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SpeechConfigResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    model: str
    language: str
    max_file_mb: int


class SpeechConfigBody(BaseModel):
    """Request body for ``PUT /api/speech/config``."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    model: str = Field(min_length=3)  # must contain ":"
    language: str = Field(min_length=1)
    max_file_mb: int = Field(gt=0)


class TranscribeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
