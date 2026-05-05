"""Request and response schemas for ``/api/settings`` endpoints."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SandboxSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    denied_patterns: list[str] = Field(default_factory=list)


class UpdateStatusBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_version: str
    latest_version: str | None = None
    update_available: bool = False
    can_install: bool
    install_blocked_reason: str | None = None


class UpdateInstallBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
