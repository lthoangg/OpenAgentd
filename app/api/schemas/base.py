"""Shared primitives for API request/response models."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, ValidationError, model_serializer


class _ExcludeNoneModel(BaseModel):
    """Drop null fields from JSON — smaller payloads over SSE/REST.

    Uses model_serializer so Pydantic's Rust serializer strips nulls
    at every level — works with FastAPI's direct response model path.
    """

    model_config = ConfigDict(from_attributes=True)

    @model_serializer(mode="wrap")
    def _exclude_none(self, handler):
        return {k: v for k, v in handler(self).items() if v is not None}


def _validation_detail(exc: ValidationError) -> str:
    """Extract a human-readable detail string from a Pydantic ValidationError."""
    return "; ".join(
        f"{'.'.join(str(loc) for loc in e['loc'])}: {e['msg']}"
        if e.get("loc")
        else e["msg"]
        for e in exc.errors(include_url=False)
    )
