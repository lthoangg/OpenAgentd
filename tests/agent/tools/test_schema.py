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
