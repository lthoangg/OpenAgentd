"""Tests for app/core/errors.py — domain exception hierarchy."""

from __future__ import annotations

from app.agent.errors import (
    AgentConfigError,
    OpenAgentdError,
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderError,
    ProviderRateLimitError,
    ProviderRequestError,
    RoutingError,
    SandboxError,
    SessionError,
    SessionNotFoundError,
    ToolArgumentError,
    ToolError,
    ToolExecutionError,
    ToolNotFoundError,
)


class TestExceptionHierarchy:
    """Verify the inheritance tree is correct."""

    def test_all_inherit_from_openagentd_error(self):
        for exc_cls in (
            ProviderError,
            ProviderRateLimitError,
            ProviderConnectionError,
            ProviderAuthenticationError,
            ProviderRequestError,
            ToolError,
            ToolNotFoundError,
            ToolArgumentError,
            ToolExecutionError,
            SandboxError,
            SessionError,
            SessionNotFoundError,
            AgentConfigError,
            RoutingError,
        ):
            assert issubclass(exc_cls, OpenAgentdError), f"{exc_cls.__name__}"

    def test_provider_subtypes(self):
        assert issubclass(ProviderRateLimitError, ProviderError)
        assert issubclass(ProviderConnectionError, ProviderError)
        assert issubclass(ProviderAuthenticationError, ProviderError)
        assert issubclass(ProviderRequestError, ProviderError)

    def test_provider_request_error_carries_metadata(self):
        exc = ProviderRequestError("bad model", status_code=400, provider="gpt-4o")
        assert str(exc) == "bad model"
        assert exc.status_code == 400
        assert exc.provider == "gpt-4o"

    def test_provider_authentication_error_carries_metadata(self):
        exc = ProviderAuthenticationError("no key", status_code=401, provider="claude")
        assert str(exc) == "no key"
        assert exc.status_code == 401
        assert exc.provider == "claude"

    def test_provider_connection_error_carries_metadata(self):
        exc = ProviderConnectionError(
            "unreachable", error_type="ReadTimeout", provider="gpt-4o"
        )
        assert str(exc) == "unreachable"
        assert exc.error_type == "ReadTimeout"
        assert exc.provider == "gpt-4o"

    def test_tool_subtypes(self):
        assert issubclass(ToolNotFoundError, ToolError)
        assert issubclass(ToolArgumentError, ToolError)
        assert issubclass(ToolExecutionError, ToolError)

    def test_sandbox_also_permission_error(self):
        """SandboxError inherits from both OpenAgentdError and PermissionError."""
        assert issubclass(SandboxError, PermissionError)

    def test_session_subtypes(self):
        assert issubclass(SessionNotFoundError, SessionError)

    def test_can_raise_and_catch(self):
        with __import__("pytest").raises(OpenAgentdError):
            raise ToolNotFoundError("tool_xyz")

    def test_error_message_preserved(self):
        exc = ToolArgumentError("bad args for search")
        assert str(exc) == "bad args for search"


class TestFormatAgentError:
    """Verify format_agent_error produces structured error dicts."""

    def test_provider_authentication_error(self):
        from app.agent.errors import ProviderAuthenticationError, format_agent_error

        exc = ProviderAuthenticationError("Invalid API Key")
        res = format_agent_error(exc, agent_name="lead")
        assert res["title"] == "Provider Authentication Failed"
        assert res["code"] == "provider_auth_failed"
        assert res["category"] == "provider"
        assert res["message"] == "Invalid API Key"
        assert res["agent"] == "lead"

    def test_provider_rate_limit_error(self):
        from app.agent.errors import ProviderRateLimitError, format_agent_error

        exc = ProviderRateLimitError("429 Too Many Requests")
        res = format_agent_error(exc)
        assert res["title"] == "Rate Limit Exceeded"
        assert res["code"] == "provider_rate_limit"
        assert res["category"] == "provider"

    def test_provider_connection_error(self):
        from app.agent.errors import ProviderConnectionError, format_agent_error

        exc = ProviderConnectionError("Timeout", provider="anthropic")
        res = format_agent_error(exc)
        assert res["title"] == "anthropic Connection Failed"
        assert res["code"] == "provider_connection_failed"
        assert res["category"] == "network"

    def test_tool_execution_error(self):
        from app.agent.errors import ToolExecutionError, format_agent_error

        exc = ToolExecutionError("Command failed")
        res = format_agent_error(exc)
        assert res["title"] == "Tool Execution Failed"
        assert res["code"] == "tool_execution_failed"
        assert res["category"] == "tool"

    def test_generic_exception(self):
        from app.agent.errors import format_agent_error

        exc = RuntimeError("Unexpected boom")
        res = format_agent_error(exc)
        assert res["title"] == "Agent Execution Error"
        assert res["code"] == "agent_execution_failed"
        assert res["category"] == "system"


# ---------------------------------------------------------------------------
# format_validation_error — clean Pydantic error formatting
# ---------------------------------------------------------------------------


class TestFormatValidationError:
    """format_validation_error strips Pydantic noise and emits clean messages.

    Covers every distinct error shape produced by Pydantic v2:
    - wrong type on a top-level field
    - missing required field(s)
    - multiple errors in one exception
    - numeric range constraint violation
    - nested loc (list item → nested model field)
    - deeply nested loc (list → model → field)
    - model-level validator (empty loc)
    - field_validator raising ValueError
    - no docs URL in output
    - no type codes in output
    - no raw input_value in output
    """

    def _make(self, model_cls, **kwargs):
        """Return the ValidationError raised when constructing model_cls(**kwargs)."""
        from pydantic import ValidationError

        try:
            model_cls(**kwargs)
        except ValidationError as exc:
            return exc
        raise AssertionError("expected ValidationError was not raised")

    # -- helpers common to every test -----------------------------------------

    def _fmt(self, exc):
        from app.agent.errors import format_validation_error

        return format_validation_error(exc)

    # -------------------------------------------------------------------------

    def test_wrong_type_single_field(self):
        """list field passed as a string → clean 'field: msg' format."""
        from pydantic import BaseModel

        class M(BaseModel):
            members: list[str]

        result = self._fmt(self._make(M, members='["x"]'))
        assert result == "members: Input should be a valid list"

    def test_missing_required_field(self):
        """Missing required field → 'field: Field required'."""
        from pydantic import BaseModel

        class M(BaseModel):
            name: str

        result = self._fmt(self._make(M))
        assert result == "name: Field required"

    def test_multiple_missing_fields_joined_by_semicolon(self):
        """Multiple errors are joined with '; '."""
        from pydantic import BaseModel

        class M(BaseModel):
            a: str
            b: int

        result = self._fmt(self._make(M))
        assert "a: Field required" in result
        assert "b: Field required" in result
        assert "; " in result

    def test_range_constraint_ge(self):
        """ge constraint violation → clean message, no type code."""
        from pydantic import BaseModel, Field

        class M(BaseModel):
            n: int = Field(ge=1)

        result = self._fmt(self._make(M, n=0))
        assert "n" in result
        assert "greater than or equal to 1" in result

    def test_range_constraint_le(self):
        """le constraint violation → clean message."""
        from pydantic import BaseModel, Field

        class M(BaseModel):
            n: int = Field(le=10)

        result = self._fmt(self._make(M, n=999))
        assert "n" in result
        assert "less than or equal to 10" in result

    def test_nested_loc_list_item_field(self):
        """Error inside a list item includes the full loc path."""
        from pydantic import BaseModel

        class Item(BaseModel):
            value: int

        class M(BaseModel):
            items: list[Item]

        result = self._fmt(self._make(M, items=[{"value": "bad"}]))
        # loc is (items, 0, value)
        assert "items" in result
        assert "0" in result
        assert "value" in result

    def test_deeply_nested_loc(self):
        """Three-level nesting produces 'a -> 0 -> x -> y: msg' path."""
        from pydantic import BaseModel

        class Inner(BaseModel):
            y: int

        class Mid(BaseModel):
            x: Inner

        class M(BaseModel):
            a: list[Mid]

        result = self._fmt(self._make(M, a=[{"x": {"y": "bad"}}]))
        assert "a" in result
        assert "x" in result
        assert "y" in result

    def test_model_validator_no_loc(self):
        """model_validator errors have empty loc — emits just the message."""
        from pydantic import BaseModel, model_validator

        class M(BaseModel):
            a: str = ""
            b: str = ""

            @model_validator(mode="after")
            def _exclusive(self):
                if self.a and self.b:
                    raise ValueError("a and b are mutually exclusive")
                return self

        result = self._fmt(self._make(M, a="x", b="y"))
        assert "a and b are mutually exclusive" in result

    def test_field_validator_message_preserved(self):
        """field_validator ValueError message is preserved verbatim."""
        from pydantic import BaseModel, field_validator

        class M(BaseModel):
            query: str

            @field_validator("query")
            @classmethod
            def _not_blank(cls, v):
                if not v.strip():
                    raise ValueError("query must not be blank")
                return v

        result = self._fmt(self._make(M, query="   "))
        assert "query" in result
        assert "query must not be blank" in result

    def test_no_docs_url_in_output(self):
        """The pydantic.dev URL is never present in the formatted string."""
        from pydantic import BaseModel

        class M(BaseModel):
            x: int

        result = self._fmt(self._make(M, x="bad"))
        assert "pydantic.dev" not in result
        assert "errors.pydantic" not in result

    def test_no_type_code_in_output(self):
        """Pydantic type codes like 'type=int_parsing' are stripped."""
        from pydantic import BaseModel

        class M(BaseModel):
            x: int

        result = self._fmt(self._make(M, x="bad"))
        assert "type=" not in result
        assert "int_parsing" not in result

    def test_no_input_value_in_output(self):
        """Raw input_value is not echoed back in the formatted string."""
        from pydantic import BaseModel

        class M(BaseModel):
            members: list[str]

        raw = '["explorer#1"]'
        result = self._fmt(self._make(M, members=raw))
        assert raw not in result
        assert "input_value" not in result

    def test_loc_separator_is_arrow(self):
        """Nested loc parts are joined with ' -> '."""
        from pydantic import BaseModel

        class Inner(BaseModel):
            v: int

        class M(BaseModel):
            items: list[Inner]

        result = self._fmt(self._make(M, items=[{"v": "x"}]))
        assert " -> " in result
