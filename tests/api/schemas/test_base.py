"""Tests for app/api/schemas/base.py — _validation_detail."""

from __future__ import annotations

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from app.api.schemas.base import _validation_detail


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _exc(model_cls, **kwargs) -> ValidationError:
    """Return the ValidationError raised by constructing model_cls(**kwargs)."""
    try:
        model_cls(**kwargs)
    except ValidationError as exc:
        return exc
    raise AssertionError("expected ValidationError was not raised")


# ---------------------------------------------------------------------------
# _validation_detail
#
# HTTP API concern: formats ValidationError into a detail string for
# HTTPException / ValueError raised as 422 responses to REST clients.
# Contract: message text only — no field loc paths, no URL, no type codes.
# ---------------------------------------------------------------------------


class TestValidationDetail:
    """_validation_detail returns clean message-only error strings.

    It is intentionally msg-only (no loc prefix) because the output goes
    into HTTPException.detail read by REST clients, not by the LLM.
    Field paths are not surfaced — only the human-readable message text.
    """

    def test_single_field_wrong_type(self):
        """Type mismatch → the Pydantic human message, no loc prefix."""

        class M(BaseModel):
            count: int

        result = _validation_detail(_exc(M, count="oops"))
        assert "Input should be a valid integer" in result

    def test_missing_required_field(self):
        class M(BaseModel):
            name: str

        result = _validation_detail(_exc(M))
        assert "Field required" in result

    def test_multiple_errors_joined_with_semicolon(self):
        class M(BaseModel):
            a: str
            b: int

        result = _validation_detail(_exc(M))
        # both messages present, joined
        assert result.count("Field required") == 2
        assert "; " in result

    def test_model_validator_message_included(self):
        """model_validator (empty loc) message appears in output."""

        class M(BaseModel):
            x: str = ""
            y: str = ""

            @model_validator(mode="after")
            def _check(self):
                if self.x and self.y:
                    raise ValueError("x and y conflict")
                return self

        result = _validation_detail(_exc(M, x="a", y="b"))
        assert "x and y conflict" in result

    def test_field_validator_message_preserved(self):
        class M(BaseModel):
            q: str

            @field_validator("q")
            @classmethod
            def _not_blank(cls, v):
                if not v.strip():
                    raise ValueError("q must not be blank")
                return v

        result = _validation_detail(_exc(M, q="  "))
        assert "q must not be blank" in result

    def test_ge_constraint_message(self):
        class M(BaseModel):
            n: int = Field(ge=1)

        result = _validation_detail(_exc(M, n=0))
        assert "greater than or equal to 1" in result

    # -- no-noise assertions --------------------------------------------------

    def test_no_docs_url(self):
        """pydantic.dev URL is never present."""

        class M(BaseModel):
            x: int

        result = _validation_detail(_exc(M, x="bad"))
        assert "pydantic.dev" not in result
        assert "errors.pydantic" not in result

    def test_no_type_code(self):
        """Pydantic type codes like 'type=int_parsing' are absent."""

        class M(BaseModel):
            x: int

        result = _validation_detail(_exc(M, x="bad"))
        assert "type=" not in result

    def test_no_raw_input_value(self):
        """Raw input_value is not echoed back."""

        class M(BaseModel):
            members: list[str]

        raw = '["explorer#1"]'
        result = _validation_detail(_exc(M, members=raw))
        assert raw not in result
        assert "input_value" not in result

    def test_no_loc_prefix(self):
        """Field loc paths are NOT included — this is msg-only output."""

        class M(BaseModel):
            count: int

        result = _validation_detail(_exc(M, count="oops"))
        # loc would be ('count',) — must not appear as a prefix
        assert not result.startswith("count")
        assert ": " not in result or result.index(": ") > result.index("integer")
