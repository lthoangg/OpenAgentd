"""Tool decorator and Tool class for LLM function-calling.

There are two ways to describe a tool's arguments:

1. **Inline (default)** — annotate each parameter with
   ``Annotated[type, Field(description=...)]`` on the function signature.
   Pydantic builds the validation model and JSON Schema automatically.

2. **Explicit ``args_schema``** — pass a Pydantic ``BaseModel`` subclass to the
   decorator. The model owns argument validation (including custom validators)
   and the JSON Schema. The function receives the validated fields as keyword
   arguments matching the model's field names.

The tool ``name`` and ``description`` can be set on the decorator; both fall
back to the function name and docstring respectively.

Usage::

    from typing import Annotated
    from pydantic import BaseModel, Field
    from app.agent.tools import tool

    # 1. Inline parameter annotations
    @tool
    def search(
        query: Annotated[str, Field(description="The search query string.")],
        max_results: Annotated[int, Field(description="Max results to return.")] = 5,
    ) -> list:
        \"\"\"Search the web for current information and news.\"\"\"
        ...

    @tool(name="custom_name")
    def another_func(
        url: Annotated[str, Field(description="The URL to fetch.")],
    ) -> str:
        \"\"\"Fetch and convert a web page to Markdown.\"\"\"
        ...

    # 2. Explicit Pydantic args_schema with input validation
    class SearchArgs(BaseModel):
        query: str = Field(description="The search query string.")
        max_results: int = Field(default=5, ge=1, le=20, description="Max results.")

        @field_validator("query")
        @classmethod
        def _not_blank(cls, v: str) -> str:
            if not v.strip():
                raise ValueError("query must not be blank")
            return v

    @tool(
        name="web_search",
        description="Search the web for current information.",
        args_schema=SearchArgs,
    )
    async def web_search(query: str, max_results: int = 5) -> list:
        ...

Tools are callable (original function behaviour is preserved) and carry
LLM-compatible metadata via ``.name``, ``.description``, and ``.definition``.
"""

from __future__ import annotations

import inspect
from typing import (
    Annotated,
    Any,
    Callable,
    cast,
    get_args,
    get_origin,
    get_type_hints,
    overload,
)

from pydantic import BaseModel, ValidationError, create_model

from loguru import logger

from app.agent.errors import (
    ToolArgumentError,
    ToolExecutionError,
    format_validation_error,
)
from app.agent.tools.schema import sanitize_tool_schema


class InjectedArg:
    """Marker: annotate a tool parameter with this to hide it from the LLM schema
    and have it injected automatically at call time by the agent.

    The agent passes a ``_injected`` dict to :meth:`Tool.arun`; any parameter
    annotated ``Annotated[T, InjectedArg()]`` receives its value from that dict
    (keyed by the parameter name) and is excluded from the OpenAI tool schema so
    the LLM never sees or fills it.

    Usage::

        async def my_tool(
            query: Annotated[str, Field(description="Search query")],
            _state: Annotated["AgentState | None", InjectedArg()] = None,
        ) -> str:
            # _state is injected by the agent; use it to read messages,
            # session_id, context, etc.
            ...

    The agent calls::

        result = await tool.arun(_injected={"_state": state}, query="...")
    """


def _is_injected(annotation: Any) -> bool:
    """Return True if the annotation contains an InjectedArg marker."""
    if get_origin(annotation) is Annotated:
        for meta in get_args(annotation)[1:]:
            if isinstance(meta, InjectedArg):
                return True
    return False


def _resolve_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline ``$ref`` pointers and drop ``$defs`` from a JSON Schema.

    Pydantic v2's ``model_json_schema()`` emits ``$defs`` + ``$ref`` when a
    parameter uses a nested Pydantic model (e.g. ``list[RememberItem]``).
    Some LLM providers (Gemini, Vertex) reject ``$ref`` outright, so we
    resolve every reference in-place and strip the ``$defs`` block.

    Also strips ``title`` from inlined definitions since providers don't need it.
    """
    defs = schema.get("$defs", {})
    if not defs:
        return schema

    def _inline(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                ref_path = node["$ref"]  # e.g. "#/$defs/RememberItem"
                ref_name = ref_path.rsplit("/", 1)[-1]
                resolved = defs.get(ref_name, node)
                # Deep-copy and recurse (defs can themselves contain $ref)
                resolved = _inline({k: v for k, v in resolved.items()})
                resolved.pop("title", None)
                return resolved
            return {k: _inline(v) for k, v in node.items()}
        if isinstance(node, list):
            return [_inline(item) for item in node]
        return node

    result = _inline({k: v for k, v in schema.items() if k != "$defs"})
    return result


class Tool:
    """A callable function decorated with LLM function-calling metadata.

    Wraps a plain Python function (sync or async) and exposes:

    * ``.name`` — tool name used in function-calling payloads
    * ``.description`` — use-case description sent to the LLM (from docstring)
    * ``.definition`` — OpenAI-compatible tool definition dict
    * Direct call — ``tool_obj(...)`` delegates to the original function
    * ``await tool_obj.arun(...)`` — validates args with Pydantic, then calls
      the function (supports both sync and async underlying functions)

    Parameter descriptions are sourced from ``Field(description=...)`` inside
    ``Annotated`` type hints on the function signature, or from an explicit
    Pydantic ``args_schema`` model passed to the constructor / ``@tool``
    decorator (which also enables custom validators and field constraints).
    """

    def __init__(
        self,
        func: Callable,
        *,
        name: str | None = None,
        description: str | Callable[[], str] | None = None,
        args_schema: type[BaseModel] | None = None,
    ) -> None:
        self._func = func
        # ``Callable`` is the abstract type; only function objects guarantee
        # ``__name__``. Fall back to ``repr`` for callables that don't (e.g.
        # ``functools.partial``) — the explicit *name* kwarg should be used
        # in that case.
        self.name = name or getattr(func, "__name__", repr(func))
        self._custom_description = description
        self._args_schema = args_schema
        # When the function takes the validated model as a single argument
        # (``def fn(args: MyArgs)``) we pass the model instance instead of
        # unpacking its fields. Resolved in ``_build``.
        self._model_param: str | None = None

        self._model, self._definition, self._injected_params = self._build()
        self._description_factory: Callable[[], str] | None = (
            cast(Callable[[], str], description) if callable(description) else None
        )

        # Preserve function metadata so the Tool looks like the original function
        self.__name__ = self.name
        self.__doc__ = func.__doc__
        self.__wrapped__ = func

    # ------------------------------------------------------------------
    # Callable interface — keeps the original function behaviour
    # ------------------------------------------------------------------

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self._func(*args, **kwargs)

    def __repr__(self) -> str:
        return f"Tool(name={self.name!r})"

    # ------------------------------------------------------------------
    # LLM-facing metadata
    # ------------------------------------------------------------------

    @property
    def description(self) -> str:
        if self._description_factory is not None:
            return self._description_factory()
        return self._definition["function"]["description"]

    @property
    def definition(self) -> dict[str, Any]:
        """OpenAI-compatible tool definition dict."""
        if self._description_factory is None:
            return self._definition
        definition = {
            **self._definition,
            "function": {**self._definition["function"]},
        }
        definition["function"]["description"] = self._description_factory()
        return definition

    # ------------------------------------------------------------------
    # Validated execution (used by Agent)
    # ------------------------------------------------------------------

    async def arun(self, _injected: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        """Execute the tool with Pydantic validation.

        Args:
            _injected: Optional dict of runtime-injected values for parameters
                annotated with :class:`InjectedArg`.  These are merged into the
                call after validation and are never exposed to the LLM.  The
                standard key is ``"_state"`` (an :class:`~app.core.state.AgentState`
                instance).
            **kwargs: LLM-provided arguments (validated against the schema).

        Raises:
            :exc:`~app.core.errors.ToolArgumentError`: When Pydantic validation
                of LLM-provided arguments fails.
            :exc:`~app.core.errors.ToolExecutionError`: When the underlying tool
                function raises any other exception.

        Supports both synchronous and asynchronous underlying functions.
        """
        logger.debug("tool_arun tool={} kwargs={}", self.name, list(kwargs.keys()))
        # Strip injected param names that might accidentally appear in kwargs
        llm_kwargs = {k: v for k, v in kwargs.items() if k not in self._injected_params}
        try:
            validated_model = self._model(**llm_kwargs)
        except ValidationError as exc:
            raise ToolArgumentError(
                f"Invalid arguments for tool '{self.name}': {format_validation_error(exc)}"
            ) from exc
        if self._model_param is not None:
            # The function wants the validated model as a single argument.
            validated: dict[str, Any] = {self._model_param: validated_model}
        else:
            # Build kwargs from model attributes — preserves nested Pydantic
            # model instances (e.g. list[RememberItem]) instead of collapsing
            # them to dicts as model_dump() would do.
            validated = {
                field: getattr(validated_model, field)
                for field in validated_model.model_fields
            }
        # Merge injected values (not validated — they come from trusted internal code)
        if _injected and self._injected_params:
            for pname in self._injected_params:
                if pname in _injected:
                    validated[pname] = _injected[pname]
        try:
            if inspect.iscoroutinefunction(self._func):
                return await self._func(**validated)
            return self._func(**validated)
        except (ToolArgumentError, ToolExecutionError):
            raise  # already domain errors — let them propagate unchanged
        except (
            FileNotFoundError,
            FileExistsError,
            IsADirectoryError,
            NotADirectoryError,
            OSError,
            ValueError,
        ) as exc:
            # Me message already clear — no need add noise
            raise ToolExecutionError(str(exc)) from exc
        except Exception as exc:
            raise ToolExecutionError(
                f"Tool '{self.name}' raised {type(exc).__name__}: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # Schema / definition builder
    # ------------------------------------------------------------------

    def _build(self) -> tuple[type[BaseModel], dict[str, Any], set[str]]:
        func = self._func
        sig = inspect.signature(func)

        # Description: custom override or the full docstring (use-case focused)
        raw_doc = inspect.getdoc(func) or ""
        description = (
            raw_doc.strip()
            if self._custom_description is None or callable(self._custom_description)
            else self._custom_description
        )

        # Injected params always come from the function signature — they are
        # supplied by the agent at call time and excluded from the LLM schema,
        # regardless of whether an explicit ``args_schema`` is used.
        type_hints = get_type_hints(func, include_extras=True)
        injected_params: set[str] = {
            param_name
            for param_name, _ in sig.parameters.items()
            if param_name != "self" and _is_injected(type_hints.get(param_name, Any))
        }

        if self._args_schema is not None:
            # An explicit Pydantic model owns validation + JSON Schema. The
            # function receives either the validated fields as keyword
            # arguments, or — when it declares a single parameter annotated
            # with the schema type — the validated model instance itself.
            ParameterModel = self._args_schema
            for param_name in sig.parameters:
                if param_name == "self" or param_name in injected_params:
                    continue
                if type_hints.get(param_name) is self._args_schema:
                    self._model_param = param_name
                    break
        else:
            # Build the validation model from the function signature.
            # include_extras=True preserves Annotated[..., Field(...)] wrappers
            # so Pydantic picks up Field metadata (description, constraints)
            # when generating the JSON Schema.
            fields: dict[str, Any] = {}
            for param_name, param in sig.parameters.items():
                if param_name == "self" or param_name in injected_params:
                    continue
                annotation = type_hints.get(param_name, Any)
                default = (
                    param.default
                    if param.default is not inspect.Parameter.empty
                    else ...
                )
                fields[param_name] = (annotation, default)

            ParameterModel = create_model(f"{self.name}_parameters", **fields)

        schema = ParameterModel.model_json_schema()

        # Resolve $ref pointers — Pydantic emits $defs + $ref for nested
        # models (e.g. list[SomeModel]).  Gemini and other providers reject
        # $ref, so we inline every reference and drop the $defs block.
        schema = _resolve_refs(schema)

        properties: dict[str, Any] = schema.get("properties", {})
        required: list[str] = schema.get("required", [])

        # Strip Pydantic-generated noise (title on each property)
        for prop in properties.values():
            prop.pop("title", None)

        definition: dict[str, Any] = {
            "type": "function",
            "function": {
                "name": self.name,
                "description": description,
                "parameters": sanitize_tool_schema(
                    {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    }
                ),
            },
        }

        return ParameterModel, definition, injected_params


# ---------------------------------------------------------------------------
# @tool decorator
# ---------------------------------------------------------------------------


@overload
def tool(func: Callable) -> Tool: ...


@overload
def tool(
    func: None = None,
    *,
    name: str | None = None,
    description: str | Callable[[], str] | None = None,
    args_schema: type[BaseModel] | None = None,
) -> Callable[[Callable], Tool]: ...


def tool(
    func: Callable | None = None,
    *,
    name: str | None = None,
    description: str | Callable[[], str] | None = None,
    args_schema: type[BaseModel] | None = None,
) -> Tool | Callable[[Callable], Tool]:
    """Decorator that converts a function into a :class:`Tool`.

    Argument schemas come from one of two sources:

    * Inline ``Annotated[type, Field(description=...)]`` hints on the signature
      (default), or
    * an explicit Pydantic ``args_schema`` model that owns validation and the
      JSON Schema (enables custom validators, constraints, cross-field checks).

    The docstring describes the tool's use case for the LLM; ``description``
    overrides it.

    Can be used with or without arguments::

        @tool
        def my_func(
            x: Annotated[int, Field(description="The input value.")],
        ) -> str:
            \"\"\"Convert a number to its string representation.\"\"\"
            ...

        @tool(name="custom")
        def my_func(...): ...

        class MyArgs(BaseModel):
            x: int = Field(ge=0, description="The input value.")

        @tool(name="custom", description="Do a thing.", args_schema=MyArgs)
        def my_func(x: int) -> str: ...

        # Or receive the validated model directly:
        @tool(args_schema=MyArgs)
        def my_func(args: MyArgs) -> str: ...

    Args:
        func: The function to wrap (only when used as a bare ``@tool``).
        name: Override the tool name (defaults to the function name).
        description: Override the tool description (defaults to the docstring).
        args_schema: Pydantic model defining and validating the tool's
            arguments. When omitted, the schema is derived from the signature.

    Returns:
        A :class:`Tool` instance, or a decorator that returns one.
    """
    if func is not None:
        # Used as bare @tool (no parentheses)
        return Tool(func)

    # Used as @tool(...) with keyword arguments
    def decorator(f: Callable) -> Tool:
        return Tool(f, name=name, description=description, args_schema=args_schema)

    return decorator
