//! Lenient JSON Schema check of a tool call's arguments.
//!
//! The `mcp` tool checks a call's arguments against the called tool's input
//! schema before running it, so the model gets every problem named at once
//! instead of one server-side error per retry. Lenient on purpose: only the
//! keywords handled here are checked and every other one is ignored, so it
//! never refuses arguments a full validator would accept.

use regex::Regex;
use serde_json::{Map, Value};

/// A model fixes eight named problems per turn; more is noise.
const MAX_PROBLEMS: usize = 8;

/// What is wrong with `args` against `schema`, one line per problem; empty
/// when they pass. Paths are dotted with indices in brackets (`opts.depth`,
/// `tags[1]`); the root object's keys carry no prefix.
pub fn problems(schema: &Value, args: &Value) -> Vec<String> {
    let mut out = vec![];
    check(schema, args, "", &mut out);
    out
}

fn push(out: &mut Vec<String>, msg: String) {
    if out.len() < MAX_PROBLEMS && !out.contains(&msg) {
        out.push(msg);
    }
}

fn add(out: &mut Vec<String>, path: &str, what: impl std::fmt::Display) {
    push(out, format!("'{}' {what}", if path.is_empty() { "arguments" } else { path }));
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn count(n: usize, unit: &str) -> String {
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

fn check(schema: &Value, v: &Value, path: &str, out: &mut Vec<String>) {
    // `$ref` is not resolved, so such a node accepts anything.
    let Some(s) = schema.as_object().filter(|s| !s.contains_key("$ref")) else { return };
    // A null that `nullable` allows passes the whole node, `enum` included:
    // OpenAPI schemas often leave null out of the list.
    if out.len() >= MAX_PROBLEMS || nullable(s, v) {
        return;
    }
    if !type_fits(s, v) {
        let names = type_names(s);
        let article = if matches!(names[0], "integer" | "array" | "object") { "an" } else { "a" };
        let list = match names.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
            _ => names[0].to_string(),
        };
        add(out, path, format!("must be {article} {list}, not {}", describe(v)));
        return;
    }
    if let Some(options) = s.get("enum").and_then(Value::as_array).filter(|o| !o.is_empty()) {
        if !options.iter().any(|o| same(o, v)) {
            let all: Vec<String> = options.iter().map(Value::to_string).collect();
            add(out, path, format!("must be one of {}", all.join(", ")));
        }
    }
    if let Some(c) = s.get("const").filter(|c| !same(c, v)) {
        add(out, path, format!("must be {c}"));
    }
    match v {
        Value::String(t) => check_string(s, t, path, out),
        Value::Number(n) => check_number(s, n.as_f64().unwrap_or_default(), path, out),
        Value::Array(a) => check_array(s, a, path, out),
        Value::Object(o) => check_object(s, o, path, out),
        _ => {}
    }
    check_branches(s, v, path, out);
}

fn nullable(s: &Map<String, Value>, v: &Value) -> bool {
    v.is_null() && s.get("nullable") == Some(&Value::Bool(true))
}

/// JSON equality with numbers compared by value, as JSON Schema does
/// (`1.0` is `1`).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

/// The `type` keyword as a list; empty when absent or unusable.
fn type_names(s: &Map<String, Value>) -> Vec<&str> {
    match s.get("type") {
        Some(Value::String(t)) => vec![t.as_str()],
        Some(Value::Array(ts)) => ts.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    }
}

fn type_fits(s: &Map<String, Value>, v: &Value) -> bool {
    let names = type_names(s);
    names.is_empty()
        || nullable(s, v)
        || names.iter().any(|t| match *t {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "number" => v.is_number(),
            "integer" => v.as_f64().is_some_and(|f| f.fract() == 0.0),
            "boolean" => v.is_boolean(),
            "null" => v.is_null(),
            _ => true,
        })
}

fn describe(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// A `min`/`max` keyword pair against a length: `must be at least 3 characters`.
fn check_size(s: &Map<String, Value>, len: usize, (min, max): (&str, &str), what: &str, unit: &str, path: &str, out: &mut Vec<String>) {
    let limit = |k: &str| s.get(k).and_then(Value::as_f64).filter(|f| *f >= 0.0).map(|f| f as usize);
    if let Some(m) = limit(min).filter(|m| len < *m) {
        add(out, path, format!("must {what} at least {}", count(m, unit)));
    }
    if let Some(m) = limit(max).filter(|m| len > *m) {
        add(out, path, format!("must {what} at most {}", count(m, unit)));
    }
}

fn check_string(s: &Map<String, Value>, t: &str, path: &str, out: &mut Vec<String>) {
    check_size(s, t.chars().count(), ("minLength", "maxLength"), "be", "character", path, out);
    if let Some(p) = s.get("pattern").and_then(Value::as_str) {
        // A pattern the regex crate can't compile (ECMA-only syntax) is skipped, not guessed at.
        if Regex::new(p).is_ok_and(|re| !re.is_match(t)) {
            add(out, path, format!("must match the pattern {p}"));
        }
    }
}

fn check_number(s: &Map<String, Value>, n: f64, path: &str, out: &mut Vec<String>) {
    type Past = fn(f64, f64) -> bool;
    let sides: [(&str, &str, &str, &str, Past); 2] =
        [("minimum", "exclusiveMinimum", "at least", "greater than", |n, b| n < b), ("maximum", "exclusiveMaximum", "at most", "less than", |n, b| n > b)];
    for (key, ex_key, word, ex_word, past) in sides {
        // Draft 4 spells exclusive as `"exclusiveMinimum": true` next to `minimum`.
        let draft4 = s.get(ex_key) == Some(&Value::Bool(true));
        for (bound, exclusive) in [(s.get(key), draft4), (s.get(ex_key), true)] {
            let Some((b, f)) = bound.and_then(|b| Some((b, b.as_f64()?))) else { continue };
            if past(n, f) || (exclusive && n == f) {
                add(out, path, format!("must be {} {b}", if exclusive { ex_word } else { word }));
            }
        }
    }
}

fn check_array(s: &Map<String, Value>, a: &[Value], path: &str, out: &mut Vec<String>) {
    check_size(s, a.len(), ("minItems", "maxItems"), "have", "item", path, out);
    // Tuple-form `items` (an array) and `prefixItems` are not checked.
    if let Some(item) = s.get("items").filter(|i| i.is_object()) {
        let base = if path.is_empty() { "arguments" } else { path };
        for (i, el) in a.iter().enumerate() {
            check(item, el, &format!("{base}[{i}]"), out);
        }
    }
}

fn check_object(s: &Map<String, Value>, o: &Map<String, Value>, path: &str, out: &mut Vec<String>) {
    let required: Vec<&str> = s.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    for key in &required {
        if !o.contains_key(*key) {
            add(out, &join(path, key), "is required");
        }
    }
    let props = s.get("properties").and_then(Value::as_object);
    // A key may belong to a `patternProperties` entry we don't evaluate, so none counts as extra then.
    let extra = if s.contains_key("patternProperties") { None } else { s.get("additionalProperties") };
    for (key, val) in o {
        // Models send null for arguments they leave out, and servers accept it.
        if val.is_null() && !required.contains(&key.as_str()) {
            continue;
        }
        let at = join(path, key);
        match (props.and_then(|p| p.get(key)), extra) {
            (Some(sub), _) => check(sub, val, &at, out),
            (None, Some(Value::Bool(false))) => add(out, &at, format!("is not an allowed {}", if path.is_empty() { "argument" } else { "field" })),
            (None, Some(sub)) => check(sub, val, &at, out),
            (None, None) => {}
        }
    }
}

/// `allOf` applies every branch; `anyOf`/`oneOf` need one clean branch (not
/// "exactly one" for `oneOf`: lenient).
fn check_branches(s: &Map<String, Value>, v: &Value, path: &str, out: &mut Vec<String>) {
    for branch in s.get("allOf").and_then(Value::as_array).into_iter().flatten() {
        check(branch, v, path, out);
    }
    for key in ["anyOf", "oneOf"] {
        let Some(branches) = s.get(key).and_then(Value::as_array).filter(|b| !b.is_empty()) else { continue };
        let tried: Vec<Vec<String>> = branches.iter().map(|b| problems_at(b, v, path)).collect();
        if tried.iter().any(Vec::is_empty) {
            continue;
        }
        // When one branch is the only one for this kind of value, its problems are the useful ones.
        let mut fitting = branches.iter().zip(&tried).filter(|(b, _)| b.as_object().is_none_or(|b| type_fits(b, v)));
        match (fitting.next(), fitting.next()) {
            (Some((_, found)), None) => found.iter().for_each(|m| push(out, m.clone())),
            _ => add(out, path, "does not match any of the allowed forms"),
        }
    }
}

fn problems_at(schema: &Value, v: &Value, path: &str) -> Vec<String> {
    let mut out = vec![];
    check(schema, v, path, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(schema: Value, args: Value) -> Vec<String> {
        problems(&schema, &args)
    }

    /// One property `x` with `schema`, set to `value`.
    fn field(schema: Value, value: Value) -> Vec<String> {
        run(json!({"type": "object", "properties": {"x": schema}, "required": ["x"]}), json!({"x": value}))
    }

    #[test]
    fn arguments_that_satisfy_the_schema_have_no_problems() {
        let schema = json!({"type": "object", "properties": {
            "q": {"type": "string", "minLength": 1},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
            "opts": {"type": "object", "properties": {"depth": {"type": "integer"}}, "required": ["depth"]}
        }, "required": ["q"]});
        assert!(run(schema.clone(), json!({"q": "rust", "limit": 10, "tags": ["a"], "opts": {"depth": 2}})).is_empty());
        assert!(run(schema, json!({"q": "rust"})).is_empty());
    }

    #[test]
    fn a_missing_required_argument_is_named() {
        let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q", "limit"]});
        assert_eq!(run(schema, json!({})), ["'q' is required", "'limit' is required"]);
    }

    #[test]
    fn a_missing_nested_required_field_is_named_with_its_path() {
        let schema = json!({"type": "object", "properties": {"opts": {"type": "object", "required": ["depth"]}}});
        assert_eq!(run(schema, json!({"opts": {}})), ["'opts.depth' is required"]);
    }

    #[test]
    fn a_wrong_type_names_the_expected_and_the_actual_type() {
        assert_eq!(field(json!({"type": "integer"}), json!("5")), ["'x' must be an integer, not a string"]);
        assert_eq!(field(json!({"type": "string"}), json!(5)), ["'x' must be a string, not a number"]);
        assert_eq!(field(json!({"type": "boolean"}), json!([1])), ["'x' must be a boolean, not an array"]);
        assert_eq!(field(json!({"type": "array"}), json!({})), ["'x' must be an array, not an object"]);
        assert_eq!(field(json!({"type": "object"}), json!(true)), ["'x' must be an object, not a boolean"]);
        assert_eq!(field(json!({"type": "string"}), json!(null)), ["'x' must be a string, not null"]);
    }

    #[test]
    fn a_root_of_the_wrong_type_is_reported_as_arguments() {
        assert_eq!(run(json!({"type": "object"}), json!([])), ["'arguments' must be an object, not an array"]);
    }

    #[test]
    fn integer_accepts_a_whole_number_written_with_a_fraction_but_not_3_5() {
        let int = json!({"type": "integer"});
        assert!(field(int.clone(), json!(3)).is_empty());
        assert!(field(int.clone(), json!(3.0)).is_empty());
        assert_eq!(field(int, json!(3.5)), ["'x' must be an integer, not a number"]);
    }

    #[test]
    fn number_accepts_integers_and_fractions() {
        let num = json!({"type": "number"});
        assert!(field(num.clone(), json!(3)).is_empty());
        assert!(field(num, json!(3.5)).is_empty());
    }

    #[test]
    fn a_type_array_lists_the_allowed_types() {
        let either = json!({"type": ["string", "null"]});
        assert!(field(either.clone(), json!("a")).is_empty());
        assert!(field(either.clone(), json!(null)).is_empty());
        assert_eq!(field(either, json!(1)), ["'x' must be a string or null, not a number"]);
        assert_eq!(field(json!({"type": ["string", "integer", "null"]}), json!(true)), ["'x' must be a string, integer or null, not a boolean"]);
    }

    #[test]
    fn nullable_lets_null_pass_a_typed_property() {
        let schema = json!({"type": "string", "nullable": true, "enum": ["a"]});
        assert!(field(schema.clone(), json!(null)).is_empty());
        assert_eq!(field(schema, json!(1)), ["'x' must be a string, not a number"]);
    }

    #[test]
    fn a_value_outside_enum_lists_the_options() {
        assert_eq!(field(json!({"enum": ["fast", "slow"]}), json!("mid")), [r#"'x' must be one of "fast", "slow""#]);
        assert_eq!(field(json!({"enum": [1, "a", null]}), json!(2)), [r#"'x' must be one of 1, "a", null"#]);
        assert!(field(json!({"enum": ["fast", "slow"]}), json!("slow")).is_empty());
    }

    #[test]
    fn a_value_other_than_const_is_reported() {
        assert_eq!(field(json!({"const": "a"}), json!("b")), [r#"'x' must be "a""#]);
        assert!(field(json!({"const": "a"}), json!("a")).is_empty());
    }

    #[test]
    fn enum_and_const_compare_numbers_by_value() {
        assert!(field(json!({"enum": [1, 2]}), json!(1.0)).is_empty());
        assert!(field(json!({"const": 2.0}), json!(2)).is_empty());
        assert!(field(json!({"enum": [[1, {"n": 2}]]}), json!([1.0, {"n": 2.0}])).is_empty(), "inside arrays and objects too");
        assert_eq!(field(json!({"enum": [1, 2]}), json!(1.5)), ["'x' must be one of 1, 2"]);
    }

    #[test]
    fn a_string_outside_its_length_bounds_is_reported() {
        let bounds = json!({"minLength": 3, "maxLength": 5});
        assert_eq!(field(bounds.clone(), json!("ab")), ["'x' must be at least 3 characters"]);
        assert_eq!(field(bounds.clone(), json!("abcdef")), ["'x' must be at most 5 characters"]);
        assert!(field(bounds, json!("abcd")).is_empty());
    }

    #[test]
    fn a_length_bound_of_one_reads_in_the_singular() {
        assert_eq!(field(json!({"minLength": 1}), json!("")), ["'x' must be at least 1 character"]);
        assert_eq!(field(json!({"maxLength": 1}), json!("ab")), ["'x' must be at most 1 character"]);
    }

    #[test]
    fn string_length_counts_characters_not_bytes() {
        assert!(field(json!({"minLength": 3, "maxLength": 3}), json!("日本語")).is_empty());
        assert_eq!(field(json!({"minLength": 3}), json!("日本")), ["'x' must be at least 3 characters"]);
    }

    #[test]
    fn a_string_that_does_not_match_the_pattern_is_reported() {
        let tag = json!({"pattern": r"^v\d+"});
        assert_eq!(field(tag.clone(), json!("beta")), [r"'x' must match the pattern ^v\d+"]);
        assert!(field(tag, json!("v12")).is_empty());
    }

    #[test]
    fn a_pattern_is_unanchored() {
        assert!(field(json!({"pattern": r"\d+"}), json!("abc 12 def")).is_empty());
    }

    #[test]
    fn a_pattern_that_does_not_compile_is_skipped() {
        assert!(field(json!({"pattern": "(unclosed"}), json!("anything")).is_empty());
    }

    #[test]
    fn numbers_outside_minimum_and_maximum_are_reported() {
        let range = json!({"minimum": 1, "maximum": 5});
        assert_eq!(field(range.clone(), json!(0)), ["'x' must be at least 1"]);
        assert_eq!(field(range.clone(), json!(6)), ["'x' must be at most 5"]);
        assert!(field(range.clone(), json!(1)).is_empty());
        assert!(field(range, json!(5)).is_empty());
    }

    #[test]
    fn exclusive_bounds_reject_the_bound_itself() {
        let range = json!({"exclusiveMinimum": 0, "exclusiveMaximum": 10});
        assert_eq!(field(range.clone(), json!(0)), ["'x' must be greater than 0"]);
        assert_eq!(field(range.clone(), json!(10)), ["'x' must be less than 10"]);
        assert!(field(range, json!(5)).is_empty());
    }

    #[test]
    fn draft_4_boolean_exclusive_flags_make_minimum_and_maximum_exclusive() {
        let range = json!({"minimum": 0, "exclusiveMinimum": true, "maximum": 10, "exclusiveMaximum": true});
        assert_eq!(field(range.clone(), json!(0)), ["'x' must be greater than 0"]);
        assert_eq!(field(range.clone(), json!(10)), ["'x' must be less than 10"]);
        assert!(field(range, json!(1)).is_empty());
        assert!(field(json!({"minimum": 0, "exclusiveMinimum": false}), json!(0)).is_empty());
    }

    #[test]
    fn bounds_print_as_json_numbers() {
        assert_eq!(field(json!({"minimum": 0.5}), json!(0.25)), ["'x' must be at least 0.5"]);
    }

    #[test]
    fn each_array_item_is_checked_with_its_index_in_the_path() {
        let ids = json!({"type": "array", "items": {"type": "integer"}});
        assert_eq!(field(ids, json!([1, "2", 3, null])), ["'x[1]' must be an integer, not a string", "'x[3]' must be an integer, not null"]);
    }

    #[test]
    fn items_inside_nested_objects_get_a_full_path() {
        let rows = json!({"type": "array", "items": {"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}});
        assert_eq!(field(rows, json!([{"id": 1}, {}, {"id": "z"}])), ["'x[1].id' is required", "'x[2].id' must be an integer, not a string"]);
    }

    #[test]
    fn an_array_outside_its_size_bounds_is_reported() {
        let size = json!({"minItems": 1, "maxItems": 3});
        assert_eq!(field(size.clone(), json!([])), ["'x' must have at least 1 item"]);
        assert_eq!(field(size.clone(), json!([1, 2, 3, 4])), ["'x' must have at most 3 items"]);
        assert_eq!(field(json!({"minItems": 2}), json!([1])), ["'x' must have at least 2 items"]);
        assert_eq!(field(json!({"maxItems": 1}), json!([1, 2])), ["'x' must have at most 1 item"]);
        assert!(field(size, json!([1, 2])).is_empty());
    }

    #[test]
    fn tuple_form_items_and_prefix_items_are_ignored() {
        let tuple = json!({"items": [{"type": "string"}], "prefixItems": [{"type": "integer"}]});
        assert!(field(tuple, json!([1, "a"])).is_empty());
    }

    #[test]
    fn additional_properties_false_names_an_unknown_root_argument() {
        let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}, "additionalProperties": false});
        assert_eq!(run(schema, json!({"q": "a", "colour": "red"})), ["'colour' is not an allowed argument"]);
    }

    #[test]
    fn additional_properties_false_names_an_unknown_nested_field() {
        let schema = json!({"properties": {"opts": {"type": "object", "properties": {"depth": {}}, "additionalProperties": false}}});
        assert_eq!(run(schema, json!({"opts": {"depth": 1, "colour": "red"}})), ["'opts.colour' is not an allowed field"]);
    }

    #[test]
    fn additional_properties_as_a_schema_checks_the_extra_keys() {
        let schema = json!({"properties": {"q": {"type": "string"}}, "additionalProperties": {"type": "integer"}});
        assert_eq!(run(schema, json!({"q": "a", "n": 1, "m": "x"})), ["'m' must be an integer, not a string"]);
    }

    #[test]
    fn additional_properties_is_skipped_when_pattern_properties_exist() {
        let closed = json!({"properties": {"q": {}}, "patternProperties": {"^x-": {"type": "string"}}, "additionalProperties": false});
        assert!(run(closed, json!({"q": 1, "x-trace": "t"})).is_empty());
        let typed = json!({"patternProperties": {"^x-": {"type": "string"}}, "additionalProperties": {"type": "integer"}});
        assert!(run(typed, json!({"x-trace": "t"})).is_empty());
    }

    #[test]
    fn a_null_optional_argument_counts_as_left_out() {
        let schema = json!({"type": "object", "properties": {"limit": {"type": "integer"}, "mode": {"enum": ["a"]}}, "additionalProperties": false});
        assert!(run(schema, json!({"limit": null, "mode": null})).is_empty());
    }

    #[test]
    fn a_null_required_argument_is_still_checked() {
        let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]});
        assert_eq!(run(schema, json!({"q": null})), ["'q' must be a string, not null"]);
    }

    #[test]
    fn a_nullable_string_any_of_reports_the_string_branchs_problem() {
        let name = json!({"anyOf": [{"type": "string", "minLength": 3}, {"type": "null"}]});
        assert_eq!(field(name.clone(), json!("ab")), ["'x' must be at least 3 characters"]);
        assert!(field(name.clone(), json!("abc")).is_empty());
        assert!(field(name, json!(null)).is_empty());
    }

    #[test]
    fn any_of_with_no_fitting_branch_reports_the_allowed_forms_message() {
        let either = json!({"anyOf": [{"type": "string"}, {"type": "integer"}]});
        assert_eq!(field(either, json!(true)), ["'x' does not match any of the allowed forms"]);
    }

    #[test]
    fn any_of_with_several_fitting_branches_reports_the_allowed_forms_message() {
        let two = json!({"anyOf": [{"type": "string", "minLength": 3}, {"type": "string", "pattern": "^x"}]});
        assert_eq!(field(two, json!("ab")), ["'x' does not match any of the allowed forms"]);
    }

    #[test]
    fn one_of_does_not_insist_on_exactly_one_branch() {
        let both = json!({"oneOf": [{"type": "integer"}, {"type": "number"}]});
        assert!(field(both.clone(), json!(1)).is_empty());
        assert_eq!(field(both, json!("1")), ["'x' does not match any of the allowed forms"]);
    }

    #[test]
    fn all_of_collects_the_problems_of_every_branch() {
        let schema = json!({"allOf": [{"required": ["a"]}, {"required": ["b"]}, {"type": "object"}]});
        assert_eq!(run(schema, json!({})), ["'a' is required", "'b' is required"]);
    }

    #[test]
    fn a_node_with_a_ref_accepts_everything() {
        assert!(field(json!({"$ref": "#/$defs/X", "type": "string"}), json!(1)).is_empty());
        assert!(run(json!({"$ref": "#/$defs/Args", "required": ["q"]}), json!({})).is_empty());
    }

    #[test]
    fn a_schema_that_is_not_an_object_accepts_everything() {
        assert!(run(json!(true), json!({"anything": [1]})).is_empty());
        assert!(run(json!(null), json!("x")).is_empty());
        assert!(field(json!(true), json!(1)).is_empty());
    }

    #[test]
    fn unknown_keywords_are_ignored() {
        assert!(field(json!({"type": "string", "format": "email", "x-vendor": {"type": "integer"}, "default": 3}), json!("not an email")).is_empty());
    }

    #[test]
    fn collecting_stops_after_eight_problems() {
        let keys: Vec<String> = ('a'..='j').map(String::from).collect();
        let found = run(json!({"type": "object", "required": keys}), json!({}));
        assert_eq!(found.len(), 8);
        assert_eq!((found[0].as_str(), found[7].as_str()), ("'a' is required", "'h' is required"));
    }

    #[test]
    fn a_type_mismatch_reports_only_the_type_problem() {
        let schema = json!({"type": "string", "enum": ["a"], "minLength": 3, "pattern": "^a"});
        assert_eq!(field(schema, json!(5)), ["'x' must be a string, not a number"]);
    }
}
