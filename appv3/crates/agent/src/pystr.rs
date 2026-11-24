//! Python `str()` / `repr()` renderings of JSON values, for places where v2
//! interpolates parsed arguments into text.

use serde_json::Value;

pub fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|_| n.is_f64()) {
                appv3_core::pyjson::float_repr(f)
            } else {
                n.to_string()
            }
        }
        Value::String(s) => appv3_tools::py_repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", appv3_tools::py_repr_str(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
    }
}

pub fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}
