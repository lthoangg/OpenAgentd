"""API request/response models, grouped by resource.

This package replaces the previous single ``app/api/schemas.py`` module.
All public symbols are re-exported here so existing callers that do
``from app.api.schemas import X`` keep working.

Prefer importing from the per-resource submodule in new code, e.g.
``from app.api.schemas.sessions import SessionResponse``.
"""

from __future__ import annotations

from app.api.schemas.base import _ExcludeNoneModel, _validation_detail
from app.api.schemas.chat import ChatForm
from app.api.schemas.sessions import (
    MessageResponse,
    SessionCreate,
    SessionDetailResponse,
    SessionListResponse,
    SessionPageResponse,
    SessionResponse,
)
from app.api.schemas.settings import (
    SandboxSettingsBody,
    UpdateInstallBody,
    UpdateStatusBody,
)

__all__ = [
    # Shared primitives
    "_ExcludeNoneModel",
    "_validation_detail",
    # Chat form
    "ChatForm",
    # Sessions
    "MessageResponse",
    "SessionCreate",
    "SessionDetailResponse",
    "SessionListResponse",
    "SessionPageResponse",
    "SessionResponse",
    # Settings
    "SandboxSettingsBody",
    "UpdateInstallBody",
    "UpdateStatusBody",
]
