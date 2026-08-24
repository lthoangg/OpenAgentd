"""Tests for JSON Schema sanitization and normalization."""

from app.agent.tools.schema import sanitize_tool_schema


def test_sanitize_tool_schema_none_or_non_dict() -> None:
    assert sanitize_tool_schema(None) == {
        "type": "object",
        "properties": {},
        "required": [],
    }
    assert sanitize_tool_schema("invalid") == {  # type: ignore[arg-type]
        "type": "object",
        "properties": {},
        "required": [],
    }


def test_sanitize_tool_schema_strips_metadata() -> None:
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "https://example.com/schema",
        "type": "object",
        "properties": {"name": {"type": "string"}},
    }
    res = sanitize_tool_schema(schema)
    assert "$schema" not in res
    assert "$id" not in res
    assert res["properties"] == {"name": {"type": "string"}}


def test_sanitize_tool_schema_strips_titles_recursively() -> None:
    schema = {
        "title": "Request",
        "type": "object",
        "properties": {
            "items": {
                "title": "Items",
                "type": "array",
                "items": {
                    "title": "Item",
                    "type": "object",
                    "properties": {"name": {"title": "Name", "type": "string"}},
                },
            }
        },
    }

    result = sanitize_tool_schema(schema)

    def has_title(node: object) -> bool:
        if isinstance(node, dict):
            return "title" in node or any(has_title(value) for value in node.values())
        if isinstance(node, list):
            return any(has_title(value) for value in node)
        return False

    assert not has_title(result)


def test_sanitize_tool_schema_flattens_oneof() -> None:
    schema = {
        "oneOf": [
            {
                "type": "object",
                "properties": {"foo": {"type": "string"}},
                "required": ["foo"],
            },
            {
                "type": "object",
                "properties": {"bar": {"type": "number"}},
                "required": ["bar"],
            },
        ]
    }
    res = sanitize_tool_schema(schema)
    assert "oneOf" not in res
    assert res["type"] == "object"
    assert res["properties"] == {
        "foo": {"type": "string"},
        "bar": {"type": "number"},
    }
    assert res["required"] == []


def test_sanitize_tool_schema_flattens_allof() -> None:
    schema = {
        "type": "object",
        "allOf": [
            {"properties": {"a": {"type": "string"}}, "required": ["a"]},
            {"properties": {"b": {"type": "integer"}}, "required": ["b"]},
        ],
    }
    res = sanitize_tool_schema(schema)
    assert "allOf" not in res
    assert res["type"] == "object"
    assert res["properties"] == {
        "a": {"type": "string"},
        "b": {"type": "integer"},
    }
    assert res["required"] == ["a", "b"]


def test_sanitize_tool_schema_unwraps_nullable_anyof() -> None:
    schema = {
        "type": "object",
        "properties": {
            "workdir": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "default": None,
                "description": "Working directory.",
            },
            "status": {
                "anyOf": [
                    {"type": "string", "enum": ["pending", "done"]},
                    {"type": "null"},
                ],
                "default": None,
                "description": "Status.",
            },
        },
    }
    res = sanitize_tool_schema(schema)
    assert res["properties"]["workdir"] == {
        "type": "string",
        "default": None,
        "description": "Working directory.",
    }
    assert res["properties"]["status"] == {
        "type": "string",
        "enum": ["pending", "done"],
        "default": None,
        "description": "Status.",
    }


def test_sanitize_tool_schema_unwraps_single_allof_wrapper() -> None:
    schema = {
        "type": "object",
        "properties": {
            "options": {
                "allOf": [
                    {"type": "object", "properties": {"opt": {"type": "string"}}}
                ],
                "description": "Options wrapper.",
            }
        },
    }
    res = sanitize_tool_schema(schema)
    assert res["properties"]["options"] == {
        "type": "object",
        "properties": {"opt": {"type": "string"}},
        "description": "Options wrapper.",
    }
