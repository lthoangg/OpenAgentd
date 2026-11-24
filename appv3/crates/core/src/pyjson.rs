//! Python-compatible JSON text: `json.dumps(value)` defaults (`", "` / `": "`
//! separators, `ensure_ascii=True`) and Python `repr(float)` numbers. Also
//! what Python says of a JSON-decoded value: its truthiness and type name.

use serde_json::Value;

/// Python truthiness of a JSON-decoded value: `None`, `False`, zero and
/// empty strings, lists and dicts are false.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `type(v).__name__` of a JSON-decoded value.
pub fn py_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

pub fn dumps(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out, ", ", ": ", true);
    out
}

/// `json.dumps(value, separators=(",", ":"))`.
pub fn dumps_compact(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out, ",", ":", true);
    out
}

/// Python `repr(float)`.
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{:e}", f); // shortest round-trip, e.g. "1.5e16", "-1e-5"
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    if (-4..16).contains(&exp) {
        let mut s = String::new();
        if neg {
            s.push('-');
        }
        if exp < 0 {
            s.push_str("0.");
            for _ in 0..(-exp - 1) {
                s.push('0');
            }
            s.push_str(&digits);
        } else {
            let point = (exp + 1) as usize;
            if digits.len() <= point {
                s.push_str(&digits);
                for _ in 0..(point - digits.len()) {
                    s.push('0');
                }
                s.push_str(".0");
            } else {
                s.push_str(&digits[..point]);
                s.push('.');
                s.push_str(&digits[point..]);
            }
        }
        s
    } else {
        let mut s = String::new();
        if neg {
            s.push('-');
        }
        s.push_str(&digits[..1]);
        if digits.len() > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        s.push(if exp < 0 { '-' } else { '+' });
        s.push_str(&format!("{:02}", exp.abs()));
        s
    }
}

/// `json.dumps(value, indent=n)` (`ensure_ascii=True`; empty containers stay
/// `[]` / `{}`).
pub fn dumps_indent(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_indent(value, &mut out, indent, 0);
    out
}

fn write_indent(value: &Value, out: &mut String, indent: usize, level: usize) {
    let pad = |out: &mut String, l: usize| {
        out.push('\n');
        out.push_str(&" ".repeat(indent * l));
    };
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(out, level + 1);
                write_indent(item, out, indent, level + 1);
            }
            pad(out, level);
            out.push(']');
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(out, level + 1);
                write_str(k, out, true);
                out.push_str(": ");
                write_indent(v, out, indent, level + 1);
            }
            pad(out, level);
            out.push('}');
        }
        other => write(other, out, ", ", ": ", true),
    }
}

fn write_num(n: &serde_json::Number, out: &mut String) {
    if n.is_f64() {
        out.push_str(&float_repr(n.as_f64().unwrap()));
    } else {
        out.push_str(&n.to_string());
    }
}

fn write(value: &Value, out: &mut String, item_sep: &str, kv_sep: &str, ascii: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_num(n, out),
        Value::String(s) => write_str(s, out, ascii),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write(item, out, item_sep, kv_sep, ascii);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_str(k, out, ascii);
                out.push_str(kv_sep);
                write(v, out, item_sep, kv_sep, ascii);
            }
            out.push('}');
        }
    }
}

fn write_str(s: &str, out: &mut String, ascii: bool) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (ascii && (c as u32) > 0x7e) => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_match_python_repr() {
        assert_eq!(float_repr(1.0), "1.0");
        assert_eq!(float_repr(0.0001), "0.0001");
        assert_eq!(float_repr(0.00001), "1e-05");
        assert_eq!(float_repr(1.5e16), "1.5e+16");
        assert_eq!(float_repr(123.456), "123.456");
        assert_eq!(float_repr(1e15), "1000000000000000.0");
        assert_eq!(float_repr(-2.5e-7), "-2.5e-07");
    }

    #[test]
    fn dumps_matches_python() {
        let v = json!({"a": [1, 2.5, "é"], "b": null});
        assert_eq!(dumps(&v), r#"{"a": [1, 2.5, "\u00e9"], "b": null}"#);
        assert_eq!(dumps_compact(&v), r#"{"a":[1,2.5,"\u00e9"],"b":null}"#);
    }

    #[test]
    fn truthiness_is_pythons() {
        for falsy in [json!(null), json!(false), json!(0), json!(0.0), json!(-0.0), json!(""), json!([]), json!({})] {
            assert!(!truthy(&falsy), "{falsy}");
        }
        for truthy_value in [json!(true), json!(1), json!(-1), json!(0.5), json!(u64::MAX), json!(" "), json!("0"), json!([0]), json!({"a": null})] {
            assert!(truthy(&truthy_value), "{truthy_value}");
        }
    }

    /// The copies `truthy` replaced disagreed on a number with no `f64`
    /// form. There is none unless `serde_json` gains `arbitrary_precision`.
    #[test]
    fn every_json_number_has_an_f64_form() {
        for n in [json!(0), json!(u64::MAX), json!(i64::MIN), json!(1e308), json!(5e-324)] {
            assert!(n.as_f64().is_some(), "{n}");
        }
    }

    #[test]
    fn type_names_are_pythons() {
        let names: Vec<_> = [json!(null), json!(true), json!(1), json!(1.0), json!("s"), json!([]), json!({})].iter().map(py_type_name).collect();
        assert_eq!(names, ["NoneType", "bool", "int", "float", "str", "list", "dict"]);
    }
}
