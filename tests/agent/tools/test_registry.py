"""Tests for the Tool class and @tool decorator."""

from typing import Annotated, Literal

import pytest
from pydantic import BaseModel, Field, field_validator

from app.agent.errors import ToolArgumentError, ToolExecutionError
from app.agent.tools.registry import InjectedArg, Tool, tool


# ---------------------------------------------------------------------------
# @tool decorator — bare usage
# ---------------------------------------------------------------------------


def test_tool_bare_decorator_creates_tool():
    @tool
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    assert isinstance(add, Tool)
    assert add.name == "add"


def test_tool_bare_decorator_callable():
    @tool
    def double(x: int) -> int:
        """Double x."""
        return x * 2

    assert double(5) == 10


# ---------------------------------------------------------------------------
# @tool decorator — with arguments
# ---------------------------------------------------------------------------


def test_tool_with_name_override():
    @tool(name="my_custom_name")
    def some_func(x: int) -> int:
        """Does something."""
        return x

    assert some_func.name == "my_custom_name"
    assert some_func.__name__ == "my_custom_name"


def test_tool_with_description_override():
    @tool(description="Overridden description")
    def some_func(x: int) -> int:
        """Original docstring."""
        return x

    assert some_func.description == "Overridden description"


def test_tool_with_both_name_and_description():
    @tool(name="renamed", description="Custom desc")
    def original(x: int) -> int:
        """Original."""
        return x

    assert original.name == "renamed"
    assert original.description == "Custom desc"


# ---------------------------------------------------------------------------
# Docstring used as tool description (use-case focused)
# ---------------------------------------------------------------------------


def test_tool_description_from_docstring():
    @tool
    def greet(name: str) -> str:
        """Greet a user by name and return a friendly message."""
        return f"Hello, {name}"

    assert greet.description == "Greet a user by name and return a friendly message."


def test_tool_description_multiline_docstring():
    @tool
    def search(query: str) -> list:
        """Search the web for current information and news.

        Useful for finding recent events, facts, and articles.
        """
        return []

    # Full normalized docstring is used
    assert "Search the web" in search.description
    assert "Useful for finding" in search.description


# ---------------------------------------------------------------------------
# Tool.definition structure
# ---------------------------------------------------------------------------


def test_tool_definition_structure():
    @tool
    def greet(name: str) -> str:
        """Greet someone."""
        return f"Hello, {name}"

    defn = greet.definition
    assert defn["type"] == "function"
    assert defn["function"]["name"] == "greet"
    assert "parameters" in defn["function"]
    assert "name" in defn["function"]["parameters"]["properties"]


def test_tool_definition_required_params():
    @tool
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    required = add.definition["function"]["parameters"]["required"]
    assert "a" in required
    assert "b" in required


def test_tool_definition_optional_not_required():
    @tool
    def search(
        query: Annotated[str, Field(description="Search query.")],
        max_results: Annotated[int, Field(description="Max results.")] = 5,
    ) -> list:
        """Search the web."""
        return []

    required = search.definition["function"]["parameters"]["required"]
    assert "query" in required
    assert "max_results" not in required


# ---------------------------------------------------------------------------
# Field(description=...) — parameter descriptions in the JSON Schema
# ---------------------------------------------------------------------------


def test_field_description_in_schema_properties():
    @tool
    def search(
        query: Annotated[str, Field(description="The search query string.")],
        max_results: Annotated[
            int, Field(description="Maximum number of results.")
        ] = 5,
    ) -> list:
        """Search the web for current information."""
        return []

    props = search.definition["function"]["parameters"]["properties"]
    assert props["query"]["description"] == "The search query string."
    assert props["max_results"]["description"] == "Maximum number of results."


def test_no_field_description_leaves_no_description_key():
    """Plain type hints without Field produce no 'description' on the property."""

    @tool
    def noop(x: int) -> int:
        """Does nothing."""
        return x

    props = noop.definition["function"]["parameters"]["properties"]
    assert "description" not in props["x"]


def test_field_description_with_literal_type():
    @tool
    def search(
        safesearch: Annotated[
            Literal["on", "moderate", "off"],
            Field(description="Adult-content filter level."),
        ] = "moderate",
    ) -> list:
        """Search the web."""
        return []

    props = search.definition["function"]["parameters"]["properties"]
    assert props["safesearch"]["description"] == "Adult-content filter level."


def test_no_title_in_schema_properties():
    """Pydantic-generated 'title' noise is stripped from each property."""

    @tool
    def f(x: Annotated[int, Field(description="x value.")]) -> int:
        """A tool."""
        return x

    props = f.definition["function"]["parameters"]["properties"]
    assert "title" not in props["x"]


# ---------------------------------------------------------------------------
# Tool.arun — validated async execution
# ---------------------------------------------------------------------------


async def test_tool_arun_sync_function():
    @tool
    def multiply(
        a: Annotated[int, Field(description="First factor.")],
        b: Annotated[int, Field(description="Second factor.")],
    ) -> int:
        """Multiply two numbers."""
        return a * b

    result = await multiply.arun(a=3, b=4)
    assert result == 12


async def test_tool_arun_async_function():
    @tool
    async def async_add(
        a: Annotated[int, Field(description="First number.")],
        b: Annotated[int, Field(description="Second number.")],
    ) -> int:
        """Add two numbers asynchronously."""
        return a + b

    result = await async_add.arun(a=10, b=20)
    assert result == 30


async def test_tool_arun_validation_error():
    @tool
    def typed(x: Annotated[int, Field(description="An integer.")]) -> int:
        """Typed tool."""
        return x

    with pytest.raises(Exception):  # Pydantic ValidationError
        await typed.arun(x="not_an_int")


async def test_tool_arun_raises_propagates():
    @tool
    def exploding(x: Annotated[int, Field(description="Input.")]) -> str:
        """Raises on call."""
        raise RuntimeError("boom")

    with pytest.raises(ToolExecutionError, match="boom"):
        await exploding.arun(x=1)


# ---------------------------------------------------------------------------
# Plain callable wrapping
# ---------------------------------------------------------------------------


def test_tool_wraps_plain_callable():
    """Tool can wrap a plain (non-decorated) callable."""

    def square(n: int) -> int:
        """Square a number."""
        return n * n

    t = Tool(square)
    assert t.name == "square"
    assert t(5) == 25


def test_tool_repr():
    @tool
    def my_func(x: int) -> int:
        """A tool."""
        return x

    assert repr(my_func) == "Tool(name='my_func')"


async def test_tool_arun_injected_param_merged():
    """InjectedArg params are not in LLM schema but are passed at runtime."""

    @tool
    async def fn_with_injection(
        x: Annotated[int, Field(description="A number.")],
        _state: Annotated[str, InjectedArg()],
    ) -> str:
        """Uses an injected arg."""
        return f"{x}:{_state}"

    result = await fn_with_injection.arun(_injected={"_state": "ctx"}, x=7)
    assert result == "7:ctx"
    # _state must NOT appear in the definition schema
    props = fn_with_injection.definition["function"]["parameters"]["properties"]
    assert "_state" not in props


async def test_tool_arun_domain_error_propagates_unchanged():
    """ToolExecutionError raised by the function is not double-wrapped."""
    from app.agent.errors import ToolExecutionError

    @tool
    def raises_domain(x: int) -> str:
        """Raises a domain error."""
        raise ToolExecutionError("domain failure")

    with pytest.raises(ToolExecutionError, match="domain failure"):
        await raises_domain.arun(x=1)


def test_injected_arg_excluded_from_schema():
    """InjectedArg parameters are not included in the tool's LLM schema."""
    from app.agent.state import AgentState

    @tool
    def needs_state(
        query: Annotated[str, Field(description="The query")],
        _state: Annotated[AgentState | None, InjectedArg()] = None,
    ) -> str:
        """A tool that accepts an injected state."""
        return query

    defn = needs_state.definition
    props = defn["function"]["parameters"]["properties"]
    # query should be in the schema
    assert "query" in props
    # _state is an InjectedArg — must NOT appear in the schema
    assert "_state" not in props


def test_self_param_excluded_from_schema():
    """The 'self' parameter of an unbound method is skipped (registry.py:213)."""

    class MyService:
        def greet(self, name: Annotated[str, Field(description="Name")]) -> str:
            """Greet someone."""
            return f"Hello, {name}"

    # Wrap the unbound method — inspect.signature will expose 'self'
    t = Tool(MyService.greet)
    defn = t.definition
    props = defn["function"]["parameters"]["properties"]
    assert "name" in props
    assert "self" not in props


# --- Nested Pydantic model preservation (regression for model_dump bug) ---


async def test_arun_preserves_nested_pydantic_models():
    """Regression: nested Pydantic models preserved through arun, not collapsed to dicts.

    The bug was that Tool.arun() called model_dump() which serialized nested
    Pydantic models to plain dicts. The fix uses direct attribute access to
    preserve model instances.
    """
    from pydantic import BaseModel

    class Item(BaseModel):
        name: str
        value: int

    @tool
    def process_items(
        items: Annotated[list[Item], Field(description="List of items to process.")],
    ) -> str:
        """Process a list of items."""
        # Would fail with AttributeError if items were dicts instead of Item instances
        return ",".join(f"{item.name}={item.value}" for item in items)

    # Simulate LLM sending dicts (which Pydantic coerces to models at validation)
    result = await process_items.arun(
        items=[{"name": "apple", "value": 5}, {"name": "banana", "value": 3}]
    )
    assert result == "apple=5,banana=3"


async def test_arun_with_list_of_pydantic_models_from_dict():
    """Regression: arun with list[PydanticModel] where LLM sends dicts.

    Simulates the real-world scenario where the LLM sends dict arguments
    that Pydantic coerces to model instances. The fix ensures they
    stay as model instances (not dicts) when passed to the function.
    """
    from pydantic import BaseModel

    class Fact(BaseModel):
        category: str
        key: str
        value: str

    @tool
    def save_facts(
        items: Annotated[list[Fact], Field(description="Facts to save.")],
    ) -> str:
        """Save facts."""
        # Would fail with AttributeError if items were dicts instead of Fact instances
        return ",".join(f"{item.category}:{item.key}" for item in items)

    # Simulate LLM sending dicts (which Pydantic coerces to models at validation)
    result = await save_facts.arun(
        items=[
            {"category": "preference", "key": "lang", "value": "Python"},
            {"category": "preference", "key": "style", "value": "concise"},
        ]
    )

    # Should succeed without AttributeError
    assert result == "preference:lang,preference:style"


async def test_arun_with_optional_nested_pydantic_model():
    """Regression: arun with optional nested Pydantic model from dict.

    Tests that optional nested models are also preserved correctly.
    """
    from pydantic import BaseModel

    class Config(BaseModel):
        key: str
        value: str | None = None

    @tool
    def process_config(
        config: Annotated[
            Config | None, Field(description="Config to process.")
        ] = None,
    ) -> str:
        """Process a config."""
        if config is None:
            return "no config"
        # This would fail with AttributeError if config were a dict
        return f"{config.key}={config.value}"

    # Test with dict (coerced to model)
    result = await process_config.arun(config={"key": "lang", "value": "Python"})
    assert result == "lang=Python"

    # Test with None (omitted)
    result = await process_config.arun()
    assert result == "no config"


async def test_arun_preserves_primitive_field_values():
    """Regression: arun still works correctly with primitive types (str, int, bool).

    Ensures the fix for nested Pydantic models doesn't break the common case
    of primitive field values.
    """

    @tool
    def compute(
        x: Annotated[int, Field(description="First number.")],
        y: Annotated[int, Field(description="Second number.")],
        multiply: Annotated[bool, Field(description="Whether to multiply.")] = False,
    ) -> int:
        """Compute x and y."""
        return x * y if multiply else x + y

    # Test with primitives
    result = await compute.arun(x=10, y=5, multiply=False)
    assert result == 15

    result = await compute.arun(x=10, y=5, multiply=True)
    assert result == 50


async def test_arun_with_optional_field_default():
    """Regression: arun applies default values for optional fields.

    Ensures that when a parameter with a default is omitted from arun kwargs,
    the default is still applied correctly.
    """

    @tool
    def greet(
        name: Annotated[str, Field(description="Person to greet.")],
        greeting: Annotated[str, Field(description="Greeting prefix.")] = "Hello",
    ) -> str:
        """Greet someone."""
        return f"{greeting}, {name}!"

    # Omit optional param — default should be applied
    result = await greet.arun(name="Alice")
    assert result == "Hello, Alice!"

    # Override optional param
    result = await greet.arun(name="Bob", greeting="Hi")
    assert result == "Hi, Bob!"


# ---------------------------------------------------------------------------
# args_schema — explicit Pydantic model for validation + JSON Schema
# ---------------------------------------------------------------------------


class _SearchArgs(BaseModel):
    """Search arguments with validation."""

    query: str = Field(description="The search query string.")
    max_results: int = Field(
        default=5, ge=1, le=20, description="Number of results (1-20)."
    )

    @field_validator("query")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("query must not be blank")
        return v


def test_args_schema_builds_definition_from_model():
    @tool(name="search", description="Search the web.", args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> list:
        return []

    defn = search.definition
    assert defn["function"]["name"] == "search"
    assert defn["function"]["description"] == "Search the web."
    props = defn["function"]["parameters"]["properties"]
    assert props["query"]["description"] == "The search query string."
    assert props["max_results"]["description"] == "Number of results (1-20)."
    # Constraints from the model carry into the JSON Schema
    assert props["max_results"]["minimum"] == 1
    assert props["max_results"]["maximum"] == 20
    assert "query" in defn["function"]["parameters"]["required"]
    assert "max_results" not in defn["function"]["parameters"]["required"]


def test_args_schema_description_falls_back_to_docstring():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> list:
        """Search the web for current information."""
        return []

    assert search.description == "Search the web for current information."


def test_args_schema_strips_property_titles():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> list:
        """Search."""
        return []

    props = search.definition["function"]["parameters"]["properties"]
    assert "title" not in props["query"]
    assert "title" not in props["max_results"]


async def test_args_schema_validation_passes_and_unpacks_fields():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> str:
        """Search."""
        return f"{query}:{max_results}"

    result = await search.arun(query="cats", max_results=3)
    assert result == "cats:3"


async def test_args_schema_applies_defaults():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> str:
        """Search."""
        return f"{query}:{max_results}"

    result = await search.arun(query="dogs")
    assert result == "dogs:5"


async def test_args_schema_constraint_violation_raises_tool_argument_error():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> str:
        """Search."""
        return query

    with pytest.raises(ToolArgumentError):
        await search.arun(query="cats", max_results=99)  # exceeds le=20


async def test_args_schema_custom_validator_raises_tool_argument_error():
    @tool(args_schema=_SearchArgs)
    def search(query: str, max_results: int = 5) -> str:
        """Search."""
        return query

    with pytest.raises(ToolArgumentError):
        await search.arun(query="   ")  # blank query rejected by field_validator


async def test_args_schema_function_receives_model_instance():
    """When the function declares a single param typed as the schema, it gets
    the validated model instance rather than unpacked fields."""

    @tool(args_schema=_SearchArgs)
    def search(args: _SearchArgs) -> str:
        """Search."""
        assert isinstance(args, _SearchArgs)
        return f"{args.query}:{args.max_results}"

    result = await search.arun(query="birds", max_results=7)
    assert result == "birds:7"


async def test_args_schema_with_injected_arg():
    """InjectedArg params still work alongside an explicit args_schema."""

    @tool(args_schema=_SearchArgs)
    async def search(
        query: str,
        max_results: int = 5,
        _state: Annotated[str, InjectedArg()] = "",
    ) -> str:
        """Search."""
        return f"{query}:{max_results}:{_state}"

    # _state is excluded from the schema
    props = search.definition["function"]["parameters"]["properties"]
    assert "_state" not in props
    result = await search.arun(_injected={"_state": "ctx"}, query="x", max_results=2)
    assert result == "x:2:ctx"


# ---------------------------------------------------------------------------
# Input-validation failure handling — what happens when args don't validate
# ---------------------------------------------------------------------------
#
# These cover the contract the tool executor relies on: a bad LLM-supplied
# argument set must raise ``ToolArgumentError`` (never reach the function body,
# never raise a raw pydantic ``ValidationError``), and the error message must
# name the tool and explain what failed so the LLM can self-correct.


async def test_validation_failure_raises_tool_argument_error_not_validation_error():
    """A bad arg raises the domain ToolArgumentError, not pydantic's."""
    from pydantic import ValidationError

    @tool
    def typed(x: Annotated[int, Field(description="An integer.")]) -> int:
        """Typed tool."""
        return x

    with pytest.raises(ToolArgumentError) as exc_info:
        await typed.arun(x="not_an_int")
    # It must NOT surface as a raw pydantic ValidationError to callers.
    assert not isinstance(exc_info.value, ValidationError)


async def test_validation_failure_message_names_tool_and_field():
    """The error message identifies the tool and the offending field."""

    @tool(name="adder")
    def add(
        a: Annotated[int, Field(description="First.")],
        b: Annotated[int, Field(description="Second.")],
    ) -> int:
        """Add."""
        return a + b

    with pytest.raises(ToolArgumentError) as exc_info:
        await add.arun(a=1, b="oops")
    msg = str(exc_info.value)
    assert "adder" in msg  # tool name surfaced
    assert "b" in msg  # offending field surfaced


async def test_validation_failure_does_not_invoke_function_body():
    """When validation fails, the underlying function never runs."""
    calls: list[int] = []

    @tool
    def record(x: Annotated[int, Field(description="An integer.")]) -> int:
        """Record."""
        calls.append(x)
        return x

    with pytest.raises(ToolArgumentError):
        await record.arun(x="bad")
    assert calls == []  # body skipped — fail-fast before execution


async def test_validation_failure_missing_required_field():
    """Omitting a required arg raises ToolArgumentError."""

    @tool
    def needs(
        required: Annotated[str, Field(description="Required string.")],
    ) -> str:
        """Needs a required arg."""
        return required

    with pytest.raises(ToolArgumentError):
        await needs.arun()  # required missing


async def test_validation_failure_args_schema_constraint_message():
    """args_schema constraint failures carry a descriptive message."""

    class Args(BaseModel):
        n: int = Field(ge=1, le=10, description="1-10.")

    @tool(args_schema=Args)
    def bounded(n: int) -> int:
        """Bounded."""
        return n

    with pytest.raises(ToolArgumentError) as exc_info:
        await bounded.arun(n=999)
    msg = str(exc_info.value)
    assert "bounded" in msg
    assert "n" in msg


async def test_validation_failure_nested_model_field():
    """A bad field inside a nested model raises ToolArgumentError."""

    class Item(BaseModel):
        name: str
        value: int

    @tool
    def process(
        items: Annotated[list[Item], Field(description="Items.")],
    ) -> str:
        """Process."""
        return ",".join(i.name for i in items)

    with pytest.raises(ToolArgumentError):
        # value should be int — string that can't coerce fails validation
        await process.arun(items=[{"name": "a", "value": "not_a_number"}])


async def test_validation_unknown_extra_field_is_ignored():
    """Unexpected extra args are dropped (pydantic default 'ignore'), not fatal.

    The LLM sometimes hallucinates an extra key; we tolerate it rather than
    erroring so a single stray field doesn't abort an otherwise-valid call.
    """

    @tool
    def greet(name: Annotated[str, Field(description="Name.")]) -> str:
        """Greet."""
        return f"hi {name}"

    result = await greet.arun(name="Sam", bogus_field="ignored")
    assert result == "hi Sam"


async def test_validation_failure_then_success_on_retry():
    """A corrected retry after a validation failure succeeds (LLM self-correct)."""

    @tool
    def squared(x: Annotated[int, Field(description="Integer.")]) -> int:
        """Square."""
        return x * x

    with pytest.raises(ToolArgumentError):
        await squared.arun(x="five")  # first attempt: bad type
    # LLM corrects and retries with a valid int
    assert await squared.arun(x=5) == 25


# ---------------------------------------------------------------------------
# ToolArgumentError message cleanliness
#
# The LLM reads the error message to self-correct.  It must contain exactly
# the field path and human message — no Pydantic internals leaked through.
# ---------------------------------------------------------------------------


async def test_error_message_list_passed_as_string():
    """Regression: list field passed as a JSON string → clean message.

    Original bug: the full Pydantic repr including [type=list_type,
    input_value='[...]', input_type=str] and the docs URL was returned.
    """

    @tool(name="team_manage")
    def manage(members: Annotated[list[str], Field(description="Members.")]) -> str:
        """Manage team."""
        return ",".join(members)

    with pytest.raises(ToolArgumentError) as exc_info:
        await manage.arun(members='["explorer#1"]')

    msg = str(exc_info.value)
    assert "team_manage" in msg
    assert "members" in msg
    # must NOT contain Pydantic noise
    assert "pydantic.dev" not in msg
    assert "type=" not in msg
    assert "input_value" not in msg
    assert "input_type" not in msg


async def test_error_message_no_docs_url():
    """No pydantic.dev URL appears in any ToolArgumentError message."""

    @tool
    def f(x: Annotated[int, Field(description="Int.")]) -> int:
        """F."""
        return x

    with pytest.raises(ToolArgumentError) as exc_info:
        await f.arun(x="bad")

    assert "pydantic.dev" not in str(exc_info.value)
    assert "errors.pydantic" not in str(exc_info.value)


async def test_error_message_no_type_code():
    """Pydantic type codes like 'type=int_parsing' are absent from the message."""

    @tool
    def f(x: Annotated[int, Field(description="Int.")]) -> int:
        """F."""
        return x

    with pytest.raises(ToolArgumentError) as exc_info:
        await f.arun(x="bad")

    assert "type=" not in str(exc_info.value)


async def test_error_message_no_raw_input_value():
    """The raw input value is not echoed back in the error message."""

    @tool(name="team_manage")
    def manage(members: Annotated[list[str], Field(description="Members.")]) -> str:
        """Manage."""
        return ""

    raw = '["explorer#1"]'
    with pytest.raises(ToolArgumentError) as exc_info:
        await manage.arun(members=raw)

    assert raw not in str(exc_info.value)


async def test_error_message_multiple_errors_joined():
    """Multiple validation errors are joined with '; ' in one message."""

    @tool(name="multi")
    def f(
        a: Annotated[str, Field(description="A.")],
        b: Annotated[int, Field(description="B.")],
    ) -> str:
        """F."""
        return f"{a}{b}"

    with pytest.raises(ToolArgumentError) as exc_info:
        await f.arun()  # both required fields missing

    msg = str(exc_info.value)
    assert "multi" in msg
    assert "a" in msg
    assert "b" in msg
    assert "; " in msg


async def test_error_message_nested_loc_path():
    """Nested loc is rendered as 'outer -> index -> field: msg'."""

    class Item(BaseModel):
        value: int

    @tool(name="processor")
    def process(
        items: Annotated[list[Item], Field(description="Items.")],
    ) -> str:
        """Process."""
        return ""

    with pytest.raises(ToolArgumentError) as exc_info:
        await process.arun(items=[{"value": "not_an_int"}])

    msg = str(exc_info.value)
    assert "processor" in msg
    assert "items" in msg
    assert "value" in msg
    assert " -> " in msg  # nested separator


async def test_error_message_model_validator_no_loc():
    """model_validator errors (empty loc) surface just the message, no prefix."""
    from pydantic import model_validator

    class Args(BaseModel):
        a: str = ""
        b: str = ""

        @model_validator(mode="after")
        def _exclusive(self):
            if self.a and self.b:
                raise ValueError("a and b are mutually exclusive")
            return self

    @tool(name="exclusive_tool", args_schema=Args)
    def f(a: str, b: str) -> str:
        """F."""
        return a

    with pytest.raises(ToolArgumentError) as exc_info:
        await f.arun(a="x", b="y")

    msg = str(exc_info.value)
    assert "exclusive_tool" in msg
    assert "a and b are mutually exclusive" in msg
    # no ' -> ' prefix for root-level error
    assert "pydantic.dev" not in msg


async def test_error_message_range_constraint():
    """Numeric constraint violation produces a descriptive clean message."""

    @tool(name="bounded")
    def f(n: Annotated[int, Field(ge=1, le=10, description="1-10.")]) -> int:
        """Bounded."""
        return n

    with pytest.raises(ToolArgumentError) as exc_info:
        await f.arun(n=999)

    msg = str(exc_info.value)
    assert "bounded" in msg
    assert "n" in msg
    assert "less than or equal to 10" in msg
    assert "pydantic.dev" not in msg


async def test_error_message_field_validator():
    """Custom field_validator message is preserved verbatim."""
    from pydantic import field_validator

    class Args(BaseModel):
        query: str

        @field_validator("query")
        @classmethod
        def _not_blank(cls, v):
            if not v.strip():
                raise ValueError("query must not be blank")
            return v

    @tool(name="searcher", args_schema=Args)
    def search(query: str) -> str:
        """Search."""
        return query

    with pytest.raises(ToolArgumentError) as exc_info:
        await search.arun(query="   ")

    msg = str(exc_info.value)
    assert "searcher" in msg
    assert "query must not be blank" in msg
    assert "pydantic.dev" not in msg


# ---------------------------------------------------------------------------
# LLM-emitted malformed numeric strings
#
# Regression guard for a production failure: models emit a trailing comma
# *inside* the JSON string value for numeric args, e.g.
#   {"path": "app/agent/permission.py", "offset": "180, ", "limit": 120}
# Pydantic coerces "300" happily but rejects "180, ", so a whole turn was
# burned on `Invalid arguments for tool 'read': offset: Input should be a
# valid integer`. Numeric fields must tolerate surrounding whitespace and
# trailing commas without weakening real type validation.
# ---------------------------------------------------------------------------


async def test_int_arg_accepts_numeric_string_with_trailing_comma():
    """The exact production payload: offset="180, " coerces to 180."""

    @tool
    def read_at(
        path: Annotated[str, Field(description="Path.")],
        offset: Annotated[int, Field(description="Start line.")] = 1,
    ) -> tuple[str, int]:
        """Read at an offset."""
        return path, offset

    assert await read_at.arun(path="a.py", offset="180, ") == ("a.py", 180)


async def test_int_arg_accepts_numeric_string_with_trailing_whitespace():
    """Surrounding whitespace alone is also tolerated."""

    @tool
    def offset_only(
        offset: Annotated[int, Field(description="Start line.")] = 1,
    ) -> int:
        """Take an offset."""
        return offset

    assert await offset_only.arun(offset="  405 ") == 405


async def test_float_arg_accepts_numeric_string_with_trailing_comma():
    """Coercion is not int-only — floats get the same treatment."""

    @tool
    def scale(
        factor: Annotated[float, Field(description="Factor.")] = 1.0,
    ) -> float:
        """Scale."""
        return factor

    assert await scale.arun(factor="1.5, ") == 1.5


async def test_plain_numeric_string_still_coerces():
    """Regression guard: ordinary numeric strings keep working."""

    @tool
    def limited(
        limit: Annotated[int, Field(description="Limit.")] = 10,
    ) -> int:
        """Limit."""
        return limit

    assert await limited.arun(limit="300") == 300


async def test_non_numeric_string_still_raises_tool_argument_error():
    """Sanitising must not swallow genuinely invalid values."""

    @tool
    def strict(
        x: Annotated[int, Field(description="An integer.")],
    ) -> int:
        """Strict."""
        return x

    with pytest.raises(ToolArgumentError):
        await strict.arun(x="not_a_number, ")


async def test_string_arg_with_trailing_comma_is_left_untouched():
    """Only numeric fields are sanitised — string values stay verbatim."""

    @tool
    def echo(
        text: Annotated[str, Field(description="Text.")],
    ) -> str:
        """Echo."""
        return text

    assert await echo.arun(text="180, ") == "180, "
