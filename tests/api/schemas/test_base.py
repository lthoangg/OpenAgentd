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
# _validation_detail — mirrors format_validation_error but in the API layer
# ---------------------------------------------------------------------------


class TestValidationDetail:
    """_validation_detail produces clean, single-line error summaries.

    Shares the same correctness contract as format_validation_error:
    field path + message only, no URL, no type codes, no raw input value.
    """

    def test_wrong_type_includes_field_and_message(self):
        """Basic type mismatch → 'field: msg'."""

        class M(BaseModel):
            count: int

        result = _validation_detail(_exc(M, count="oops"))
        assert "count" in result
        assert "pydantic.dev" not in result

    def test_missing_required_field(self):
        class M(BaseModel):
            name: str

        result = _validation_detail(_exc(M))
        assert "name" in result
        assert "Field required" in result

    def test_multiple_errors_joined_with_semicolon(self):
        class M(BaseModel):
            a: str
            b: int

        result = _validation_detail(_exc(M))
        assert "a" in result
        assert "b" in result
        assert "; " in result

    def test_nested_loc_included(self):
        """Nested loc path appears in the output."""

        class Item(BaseModel):
            v: int

        class M(BaseModel):
            items: list[Item]

        result = _validation_detail(_exc(M, items=[{"v": "bad"}]))
        assert "items" in result
        assert "v" in result

    def test_model_validator_no_loc(self):
        """model_validator errors (empty loc) are included without a prefix."""

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

    def test_no_docs_url(self):
        class M(BaseModel):
            x: int

        result = _validation_detail(_exc(M, x="bad"))
        assert "pydantic.dev" not in result

    def test_no_type_code(self):
        class M(BaseModel):
            x: int

        result = _validation_detail(_exc(M, x="bad"))
        assert "type=" not in result

    def test_no_raw_input_value(self):
        class M(BaseModel):
            members: list[str]

        raw = '["explorer#1"]'
        result = _validation_detail(_exc(M, members=raw))
        assert raw not in result
        assert "input_value" not in result

    def test_loc_separator_is_dot(self):
        """API layer uses '.' as loc separator (matches _validation_detail impl)."""

        class Inner(BaseModel):
            v: int

        class M(BaseModel):
            items: list[Inner]

        result = _validation_detail(_exc(M, items=[{"v": "x"}]))
        # The separator used in base.py is '.' (not ' -> ')
        assert "." in result

    def test_ge_constraint_violation(self):
        class M(BaseModel):
            n: int = Field(ge=1)

        result = _validation_detail(_exc(M, n=0))
        assert "n" in result
        assert "greater than or equal to 1" in result
