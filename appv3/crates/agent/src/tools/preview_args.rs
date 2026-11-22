//! What a `preview` call may say: its arguments, checked and turned into
//! the page commands the in-page inspector runs.

use serde_json::{json, Map, Value};
use std::time::Duration;

pub(super) const DEFAULT_LIMIT: usize = 200;
pub(super) const MAX_LIMIT: usize = 500;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const MAX_WAIT_MS: u64 = 10_000;
pub(super) const PAGE_ACTIONS: [&str; 8] = ["snapshot", "click", "fill", "press", "scroll", "navigate", "wait", "inspect"];
/// Page actions that can change what the page holds or submit it; Plan mode
/// keeps `preview` look-only.
const PLAN_MODE_BLOCKED: [&str; 3] = ["click", "fill", "press"];
/// Most page actions one `chain` call runs.
pub(super) const MAX_STEPS: usize = 20;

pub(super) enum Target {
    Url(String),
    Path(String),
}

pub(super) enum Args {
    Open(Target),
    Logs {
        target: Option<Target>,
        errors_only: bool,
        limit: usize,
        clear: bool,
    },
    /// A command for the page's inspector.
    Page {
        target: Option<Target>,
        command: Value,
        timeout: Duration,
    },
    /// Page commands run in order; the chain stops at the first failure.
    Chain {
        target: Option<Target>,
        steps: Vec<(Value, Duration)>,
    },
}

fn str_arg(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
        Some(_) => Err(format!("{key}: Input should be a valid string")),
    }
}

/// Why Plan mode refuses this call, or `None` when it only looks: open,
/// logs, and the page actions outside [`PLAN_MODE_BLOCKED`], in a chain too.
pub(super) fn plan_mode_refusal(parsed: &Args) -> Option<String> {
    let action = |c: &Value| c.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
    let blocked = match parsed {
        Args::Open(_) | Args::Logs { .. } => None,
        Args::Page { command, .. } => Some(action(command)).filter(|a| PLAN_MODE_BLOCKED.contains(&a.as_str())),
        Args::Chain { steps, .. } => steps.iter().map(|(c, _)| action(c)).find(|a| PLAN_MODE_BLOCKED.contains(&a.as_str())),
    }?;
    Some(format!("In Plan mode, preview only looks: open, logs, snapshot, inspect, scroll, navigate, and wait. '{blocked}' is available after the plan is approved."))
}

pub(super) fn parse_args(args: &Value) -> Result<Args, Vec<String>> {
    let url = str_arg(args, "url").map_err(|e| vec![e])?;
    let path = str_arg(args, "path").map_err(|e| vec![e])?;
    let target = match (url, path) {
        (Some(_), Some(_)) => return Err(vec!["Give either url or path, not both".into()]),
        (Some(u), None) => Some(Target::Url(u)),
        (None, Some(p)) => Some(Target::Path(p)),
        (None, None) => None,
    };
    match args.get("action").and_then(Value::as_str) {
        Some("open") => target.map(Args::Open).ok_or_else(|| vec!["open needs a url or a path".into()]),
        Some("logs") => {
            let errors_only = match args.get("level").and_then(Value::as_str) {
                None | Some("all") => false,
                Some("error") => true,
                Some(_) => return Err(vec!["level: Input should be 'error' or 'all'".into()]),
            };
            let limit = match args.get("limit") {
                None | Some(Value::Null) => DEFAULT_LIMIT,
                Some(v) => match v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) {
                    Some(n) if n >= 1 => (n as usize).min(MAX_LIMIT),
                    _ => return Err(vec!["limit: Input should be a positive integer".into()]),
                },
            };
            let clear = args.get("clear").and_then(super::lax_bool).unwrap_or(false);
            Ok(Args::Logs { target, errors_only, limit, clear })
        }
        None => Err(vec!["action: Field required".into()]),
        Some("chain") => chain_steps(args).map(|steps| Args::Chain { target, steps }),
        Some(action) if PAGE_ACTIONS.contains(&action) => page_command(action, args).map(|(command, timeout)| Args::Page { target, command, timeout }),
        _ => Err(vec![format!("action: Input should be 'open', 'logs', 'chain', or one of {}", PAGE_ACTIONS.join(", "))]),
    }
}

/// The commands of a `chain`, each checked like a single page action.
fn chain_steps(args: &Value) -> Result<Vec<(Value, Duration)>, Vec<String>> {
    let steps = match args.get("steps") {
        Some(Value::Array(s)) if !s.is_empty() => s,
        None | Some(Value::Null) | Some(Value::Array(_)) => return Err(vec![r#"chain needs steps: a list of page actions, e.g. [{"action": "click", "ref": "e3"}]"#.into()]),
        Some(_) => return Err(vec!["steps: Input should be a list of page actions".into()]),
    };
    if steps.len() > MAX_STEPS {
        return Err(vec![format!("steps: at most {MAX_STEPS} steps per chain")]);
    }
    steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let prefix = |e: String| format!("steps[{i}]: {e}");
            match step.get("action").and_then(Value::as_str) {
                Some(action) if PAGE_ACTIONS.contains(&action) => page_command(action, step).map_err(|e| e.into_iter().map(prefix).collect()),
                _ => Err(vec![prefix(format!("action: Input should be one of {}", PAGE_ACTIONS.join(", ")))]),
            }
        })
        .collect()
}

/// The inspector command for a page action, and how long to wait for it.
fn page_command(action: &str, args: &Value) -> Result<(Value, Duration), Vec<String>> {
    let mut cmd = Map::new();
    cmd.insert("action".into(), json!(action));
    let one = |e: String| vec![e];
    let element_ref = str_arg(args, "ref").map_err(one)?;
    let selector = str_arg(args, "selector").map_err(one)?;
    let has_target = element_ref.is_some() || selector.is_some();
    if let Some(r) = element_ref {
        cmd.insert("ref".into(), json!(r));
    }
    if let Some(s) = selector {
        cmd.insert("selector".into(), json!(s));
    }
    let mut timeout = COMMAND_TIMEOUT;
    match action {
        "click" | "inspect" if !has_target => return Err(vec![format!("{action} needs a ref from the last snapshot or a selector")]),
        "fill" => {
            if !has_target {
                return Err(vec!["fill needs a ref from the last snapshot or a selector".into()]);
            }
            // An empty value clears the field, so it is not treated as missing.
            match args.get("value") {
                Some(Value::String(v)) => cmd.insert("value".into(), json!(v)),
                Some(Value::Bool(b)) => cmd.insert("value".into(), json!(b.to_string())),
                Some(Value::Number(n)) => cmd.insert("value".into(), json!(n.to_string())),
                _ => return Err(vec!["fill needs a value (string)".into()]),
            };
        }
        "press" => {
            let key = str_arg(args, "key").map_err(one)?.ok_or_else(|| vec!["press needs a key, such as Enter, Escape, or ArrowDown".to_string()])?;
            cmd.insert("key".into(), json!(key));
        }
        "navigate" => {
            let to = str_arg(args, "to").map_err(one)?.ok_or_else(|| vec!["navigate needs to: a path such as /pricing, or back, forward, or reload".to_string()])?;
            cmd.insert("to".into(), json!(to));
        }
        "scroll" => {
            if let Some(to) = str_arg(args, "to").map_err(one)? {
                if to != "top" && to != "bottom" {
                    return Err(vec!["to: for scroll, Input should be 'top' or 'bottom'".into()]);
                }
                cmd.insert("to".into(), json!(to));
            }
            match args.get("dy") {
                None | Some(Value::Null) => {}
                Some(v) => match v.as_f64() {
                    Some(dy) => {
                        cmd.insert("dy".into(), json!(dy));
                    }
                    None => return Err(vec!["dy: Input should be a number".into()]),
                },
            }
        }
        "wait" => {
            if let Some(text) = str_arg(args, "text").map_err(one)? {
                cmd.insert("text".into(), json!(text));
            }
            if args.get("gone").and_then(super::lax_bool).unwrap_or(false) {
                cmd.insert("gone".into(), json!(true));
            }
            let ms = match args.get("timeout_ms") {
                None | Some(Value::Null) => 5000,
                Some(v) => v.as_u64().ok_or_else(|| vec!["timeout_ms: Input should be a non-negative integer".to_string()])?.min(MAX_WAIT_MS),
            };
            cmd.insert("timeout_ms".into(), json!(ms));
            timeout = Duration::from_millis(ms) + Duration::from_secs(5);
        }
        _ => {}
    }
    Ok((Value::Object(cmd), timeout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_arguments() {
        for bad in [
            json!({}),
            json!({"action": "shot"}),
            json!({"action": "open"}),
            json!({"action": "open", "url": "http://localhost:1", "path": "a.html"}),
            json!({"action": "logs", "level": "x"}),
            json!({"action": "logs", "limit": 0}),
            json!({"action": "open", "url": 5}),
            json!({"action": "click"}),
            json!({"action": "fill", "ref": "e1"}),
            json!({"action": "press"}),
            json!({"action": "navigate"}),
            json!({"action": "scroll", "to": "left"}),
            json!({"action": "scroll", "dy": "far"}),
            json!({"action": "wait", "timeout_ms": -1}),
            json!({"action": "inspect", "ref": 3}),
            json!({"action": "chain"}),
            json!({"action": "chain", "steps": []}),
            json!({"action": "chain", "steps": "click e1"}),
            json!({"action": "chain", "steps": [{"action": "open", "path": "a.html"}]}),
            json!({"action": "chain", "steps": [{"action": "chain", "steps": []}]}),
            json!({"action": "chain", "steps": ["click"]}),
            json!({"action": "chain", "steps": vec![json!({"action": "snapshot"}); MAX_STEPS + 1]}),
        ] {
            assert!(parse_args(&bad).is_err(), "{bad}");
        }
        let err = parse_args(&json!({"action": "chain", "steps": [{"action": "snapshot"}, {"action": "fill", "ref": "e1"}]})).err().unwrap();
        assert_eq!(err, vec!["steps[1]: fill needs a value (string)".to_string()]);
        let Args::Chain { steps, target: Some(Target::Path(_)) } =
            parse_args(&json!({"action": "chain", "path": "a.html", "steps": [{"action": "fill", "ref": "e1", "value": "x"}, {"action": "click", "selector": "button"}]})).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            steps.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>(),
            vec![json!({"action": "fill", "ref": "e1", "value": "x"}), json!({"action": "click", "selector": "button"})]
        );
        assert!(matches!(parse_args(&json!({"action": "logs", "limit": "9999"})).unwrap(), Args::Logs { limit: MAX_LIMIT, .. }));
        let Args::Page { command, timeout, .. } = parse_args(&json!({"action": "wait", "text": "Saved", "timeout_ms": 60_000})).unwrap() else { panic!() };
        assert_eq!(command, json!({"action": "wait", "text": "Saved", "timeout_ms": MAX_WAIT_MS}));
        assert_eq!(timeout, Duration::from_millis(MAX_WAIT_MS) + Duration::from_secs(5));
        let Args::Page { command, .. } = parse_args(&json!({"action": "fill", "ref": "e2", "value": ""})).unwrap() else { panic!() };
        assert_eq!(command, json!({"action": "fill", "ref": "e2", "value": ""}));
        let Args::Page { command, target: Some(Target::Url(_)), .. } = parse_args(&json!({"action": "snapshot", "url": "http://localhost:5173"})).unwrap() else { panic!() };
        assert_eq!(command, json!({"action": "snapshot"}));
    }

    #[test]
    fn plan_mode_only_looks() {
        let refusal = |v: Value| plan_mode_refusal(&parse_args(&v).unwrap());
        for ok in [
            json!({"action": "open", "path": "a.html"}),
            json!({"action": "logs"}),
            json!({"action": "snapshot"}),
            json!({"action": "inspect", "ref": "e1"}),
            json!({"action": "scroll", "dy": 200}),
            json!({"action": "navigate", "to": "back"}),
            json!({"action": "wait", "text": "Ready"}),
            json!({"action": "chain", "steps": [{"action": "scroll"}, {"action": "snapshot"}]}),
        ] {
            assert_eq!(refusal(ok.clone()), None, "{ok}");
        }
        for (bad, action) in [
            (json!({"action": "click", "ref": "e1"}), "click"),
            (json!({"action": "fill", "ref": "e1", "value": "x"}), "fill"),
            (json!({"action": "press", "key": "Enter"}), "press"),
            (json!({"action": "chain", "steps": [{"action": "snapshot"}, {"action": "click", "ref": "e2"}]}), "click"),
        ] {
            let text = refusal(bad.clone()).unwrap_or_else(|| panic!("{bad} was allowed"));
            assert!(text.starts_with("In Plan mode, preview only looks") && text.contains(&format!("'{action}'")), "{text}");
        }
    }
}
