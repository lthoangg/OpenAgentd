"""JSON Schema sanitization and normalization for LLM tool calling."""

from __future__ import annotations

from typing import Any


def resolve_top_level_combinators(schema: dict[str, Any]) -> dict[str, Any]:
    """Flatten top-level oneOf, allOf, or anyOf in a JSON Schema into type: object properties.

    Anthropic and other provider APIs reject schemas that carry oneOf, allOf,
    or anyOf at the top level of an input_schema / parameters payload.
    """
    result = dict(schema)

    while any(k in result for k in ("allOf", "oneOf", "anyOf")):
        raw_props = result.get("properties")
        top_properties: dict[str, Any] = (
            dict(raw_props) if isinstance(raw_props, dict) else {}
        )
        raw_req = result.get("required")
        top_required: list[str] = (
            [str(x) for x in raw_req] if isinstance(raw_req, list) else []
        )

        all_of = result.pop("allOf", None)
        if isinstance(all_of, list):
            req_set = set(top_required)
            for sub in all_of:
                if isinstance(sub, dict):
                    sub_flat = resolve_top_level_combinators(sub)
                    sub_props = sub_flat.get("properties")
                    if isinstance(sub_props, dict):
                        for k, v in sub_props.items():
                            if k not in top_properties:
                                top_properties[k] = v
                    sub_req = sub_flat.get("required")
                    if isinstance(sub_req, list):
                        req_set.update(str(x) for x in sub_req)
            top_required = sorted(req_set)

        for combinator in ("oneOf", "anyOf"):
            branches = result.pop(combinator, None)
            if isinstance(branches, list) and branches:
                branch_req_sets: list[set[str]] = []
                for sub in branches:
                    if isinstance(sub, dict):
                        sub_flat = resolve_top_level_combinators(sub)
                        sub_props = sub_flat.get("properties")
                        if isinstance(sub_props, dict):
                            for k, v in sub_props.items():
                                if k not in top_properties:
                                    top_properties[k] = v
                        sub_req = sub_flat.get("required")
                        branch_req = (
                            {str(x) for x in sub_req}
                            if isinstance(sub_req, list)
                            else set()
                        )
                        branch_req_sets.append(branch_req)

                if branch_req_sets:
                    common_req = set.intersection(*branch_req_sets)
                    top_required = sorted(set(top_required) | common_req)

        result["properties"] = top_properties
        result["required"] = top_required
        result["type"] = "object"

    return result


def sanitize_tool_schema(schema: dict[str, Any] | None) -> dict[str, Any]:
    """Coerce a tool parameter schema into a provider-compatible JSON Schema.

    Ensures the top level has ``type: "object"``, ``properties``, and ``required``,
    strips ``$schema`` / ``$id`` metadata, and flattens top-level combinators
    (``oneOf``, ``allOf``, ``anyOf``) into valid top-level object properties.
    """
    if not schema or not isinstance(schema, dict):
        return {"type": "object", "properties": {}, "required": []}

    result = dict(schema)
    result.setdefault("type", "object")
    result.setdefault("properties", {})
    result.setdefault("required", [])

    result.pop("$schema", None)
    result.pop("$id", None)

    return resolve_top_level_combinators(result)
