//! Retry policy for provider calls — port of `app/agent/agent_loop/retry.py`
//! (parsing and classification; the retry loop itself lives in
//! [`crate::streaming`]).

use crate::errors::AgentError;
use appv3_providers::ProviderError;
use chrono::{Local, Timelike, Utc};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

pub const MAX_RETRIES: i64 = 5;
pub const MAX_QUOTA_WAIT_SECONDS: i64 = 86_400;
pub const MAX_QUOTA_WAITS: i64 = 3;
pub const CLOCK_SKEW_BUFFER_SECONDS: f64 = 2.0;
pub const BASE_DELAY: f64 = 1.0;
pub const MAX_DELAY: f64 = 60.0;
/// Transport failures (dropped connection, DNS, timeouts) usually mean the
/// network blinked, so they retry on a flat, jittered 3–5 s interval
/// instead of the exponential backoff above: the call resumes within
/// seconds of the network coming back. A turn's model call retries them
/// without limit (the user can stop it); background calls that cannot be
/// stopped (summarization) give up after 10 attempts, about 36 s.
pub const MAX_NETWORK_ATTEMPTS: i64 = 10;
pub const NETWORK_RETRY_MIN_DELAY: f64 = 3.0;
pub const NETWORK_RETRY_MAX_DELAY: f64 = 5.0;

const NON_RETRYABLE_429_MARKERS: &[&str] = &[
    "usage_limit_reached",
    "usage_not_included",
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
    "quota_exceeded",
    "insufficient_quota",
    "insufficient balance",
    "no resource package",
    "billing_not_active",
    "subscription:free-usage-exhausted",
];

fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn duration_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // Rust regex has no lookahead; the trailing-letter guard is applied manually.
    R.get_or_init(|| Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|milliseconds?|ms|minutes?|mins?|m|seconds?|secs?|s)").unwrap())
}

fn unit_mult(u: &str) -> Option<f64> {
    Some(match u.to_ascii_lowercase().as_str() {
        "d" | "day" | "days" => 86400.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "ms" | "millisecond" | "milliseconds" => 0.001,
        _ => return None,
    })
}

/// `parse_duration_string`: '2 hours 15 minutes', '6m0s', '11.054s'.
pub fn parse_duration_string(text: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut any = false;
    let bytes = text.as_bytes();
    let mut pos = 0;
    while pos < text.len() {
        let Some(caps) = duration_re().captures_at(text, pos) else {
            break;
        };
        let m = caps.get(0).unwrap();
        let unit_m = caps.get(2).unwrap();
        // Emulate `(?![a-zA-Z])` with backtracking over shorter unit alternatives.
        let mut unit = unit_m.as_str().to_string();
        let mut end = unit_m.end();
        loop {
            let next_alpha = bytes.get(end).map(|b| b.is_ascii_alphabetic()).unwrap_or(false);
            if !next_alpha && unit_mult(&unit).is_some() {
                break;
            }
            if unit.len() <= 1 {
                unit.clear();
                break;
            }
            unit.pop();
            end -= 1;
        }
        if !unit.is_empty() {
            any = true;
            if let (Ok(v), Some(mult)) = (caps[1].parse::<f64>(), unit_mult(&unit)) {
                total += v * mult;
            }
            pos = end;
        } else {
            pos = m.start() + 1;
        }
    }
    if any && total > 0.0 {
        Some(total)
    } else {
        None
    }
}

/// `parse_reset_timestamp` for string values (headers/body).
pub fn parse_reset_timestamp_str(val: &str) -> Option<i64> {
    let val = val.trim();
    if val.is_empty() {
        return None;
    }
    if val.chars().all(|c| c.is_ascii_digit()) {
        let ts: f64 = val.parse().ok()?;
        if ts > 1e11 {
            return Some(((ts / 1000.0 - now_secs()) as i64).max(0));
        }
        if ts > 1e8 {
            return Some(((ts - now_secs()) as i64).max(0));
        }
        return Some(ts as i64);
    }
    if let Ok(t) = httpdate::parse_http_date(val) {
        let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        return Some(((secs - now_secs()) as i64).max(0));
    }
    let iso = val.replace('Z', "+00:00");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&iso) {
        return Some(((dt.with_timezone(&Utc) - Utc::now()).num_seconds()).max(0));
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(&iso, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(((ndt.and_utc() - Utc::now()).num_seconds()).max(0));
    }
    None
}

/// `parse_reset_timestamp` for numeric values.
pub fn parse_reset_timestamp_num(v: f64) -> Option<i64> {
    let mut ts = v;
    if ts > 1e11 {
        ts /= 1000.0;
    }
    if ts > 1e8 {
        return Some(((ts - now_secs()) as i64).max(0));
    }
    if ts > 0.0 && ts <= MAX_QUOTA_WAIT_SECONDS as f64 {
        return Some(ts as i64);
    }
    None
}

fn parse_reset_value(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().and_then(parse_reset_timestamp_num),
        Value::String(s) => parse_reset_timestamp_str(s),
        _ => None,
    }
}

fn parse_time_after(text: &str) -> Option<i64> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?i)try again after\s+(\d{1,2}):(\d{2})(?:\s*([ap]\.?m\.?))?").unwrap());
    let c = re.captures(text)?;
    let mut hour: u32 = c[1].parse().ok()?;
    let minute: u32 = c[2].parse().ok()?;
    let ampm = c.get(3).map(|m| m.as_str().to_lowercase().replace('.', "")).unwrap_or_default();
    if ampm == "pm" && hour < 12 {
        hour += 12;
    } else if ampm == "am" && hour == 12 {
        hour = 0;
    }
    let now = Local::now();
    let target = now.with_hour(hour)?.with_minute(minute)?.with_second(0)?.with_nanosecond(0)?;
    let mut diff = (target - now).num_milliseconds() as f64 / 1000.0;
    if diff < 0.0 {
        diff += 86400.0;
    }
    Some((diff as i64).max(0))
}

/// `format_duration`: '2h 15m', '45m 10s', '30s'.
pub fn format_duration(seconds: f64) -> String {
    let secs = seconds.max(0.0) as i64;
    let days = secs / 86400;
    let hours = (secs % 86400) / 3600;
    let minutes = (secs % 3600) / 60;
    let rem = secs % 60;
    let mut parts: Vec<String> = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
        if days == 0 {
            parts.push(format!("{minutes:02}m"));
        }
    } else if minutes > 0 {
        parts.push(format!("{minutes}m"));
        if rem > 0 {
            parts.push(format!("{rem:02}s"));
        }
    } else if parts.is_empty() || rem > 0 {
        parts.push(format!("{rem}s"));
    }
    parts.join(" ")
}

/// `_backoff_delay` (equal jitter unless the server gave Retry-After).
pub fn backoff_delay(attempt: i64, retry_after: i64) -> f64 {
    if retry_after > 0 {
        return (retry_after as f64).min(MAX_DELAY);
    }
    let base = (BASE_DELAY * 3f64.powi(attempt as i32)).min(MAX_DELAY);
    base / 2.0 + rand::random::<f64>() * (base / 2.0)
}

pub fn required_delay(attempt: i64, retry_after: i64) -> f64 {
    let r = if retry_after > 0 { retry_after as f64 } else { BASE_DELAY * 3f64.powi(attempt as i32) };
    r.min(MAX_DELAY)
}

/// Wait before retrying a transport failure (see [`MAX_NETWORK_ATTEMPTS`]).
pub fn network_retry_delay() -> f64 {
    NETWORK_RETRY_MIN_DELAY + rand::random::<f64>() * (NETWORK_RETRY_MAX_DELAY - NETWORK_RETRY_MIN_DELAY)
}

/// `_is_retryable_http_error`.
pub fn is_retryable_http(status: u16, body: &str) -> bool {
    if status == 408 || status == 429 {
        return true;
    }
    if (500..600).contains(&status) && status != 501 && status != 505 {
        return true;
    }
    serde_json::from_str::<Value>(body).ok().and_then(|p| p.get("error").and_then(|e| e.get("code")).and_then(|c| c.as_str()).map(|c| c == "server_error")).unwrap_or(false)
}

pub fn is_non_retryable_429(status: u16, body: &str) -> bool {
    if status != 429 {
        return false;
    }
    let b = body.to_lowercase();
    NON_RETRYABLE_429_MARKERS.iter().any(|m| b.contains(m))
}

/// A 429 for a cap only the account owner can lift, such as Anthropic's
/// "monthly spend limit". Waiting out the reset it advertises is pointless.
pub fn is_spend_limit_429(status: u16, body: &str) -> bool {
    status == 429 && body.to_lowercase().contains("spend limit")
}

/// Upper bound on credential switches within one model call.
pub const MAX_CREDENTIAL_SWITCHES: i64 = 16;

/// For a failed request a multi-credential provider should take to its
/// next credential: why (`rate_limit`, `quota`, `spend_limit`, `auth`) and
/// how long to skip the credential that failed. `None` for errors another
/// key would not fix (bad request, unknown model, server errors).
pub fn credential_cooldown(err: &ProviderError) -> Option<(&'static str, f64)> {
    let status = err.status()?;
    let body = err.body();
    match status {
        429 if is_spend_limit_429(status, body) => Some(("spend_limit", 3600.0)),
        429 => {
            let reset = parse_retry_after(err);
            let reason = if is_non_retryable_429(status, body) || reset as f64 > MAX_DELAY { "quota" } else { "rate_limit" };
            Some((reason, if reset > 0 { reset as f64 + CLOCK_SKEW_BUFFER_SECONDS } else { MAX_DELAY }))
        }
        402 => Some(("spend_limit", 3600.0)),
        401 | 403 => Some(("auth", 600.0)),
        _ => None,
    }
}

/// How the transcript says why a credential was left.
pub fn switch_reason_text(reason: &str, cooldown_secs: f64) -> String {
    match reason {
        "rate_limit" => "was rate-limited".into(),
        "quota" => format!("hit its usage limit (resets in {})", format_duration(cooldown_secs)),
        "spend_limit" => "reached its spend limit".into(),
        "auth" => "was rejected by the provider".into(),
        _ => "failed".into(),
    }
}

/// `parse_retry_after`.
pub fn parse_retry_after(err: &ProviderError) -> i64 {
    let h = |n: &str| err.header(n).unwrap_or("").to_string();
    let v = h("retry-after");
    if !v.is_empty() {
        if let Some(ts) = parse_reset_timestamp_str(&v).filter(|t| *t > 0) {
            return ts;
        }
    }
    for name in ["x-ratelimit-reset", "ratelimit-reset", "x-ratelimit-user-reset", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"] {
        let v = h(name);
        if !v.is_empty() {
            if let Some(ts) = parse_reset_timestamp_str(&v).filter(|t| *t > 0) {
                return ts;
            }
        }
    }
    for name in ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"] {
        let v = h(name);
        if !v.is_empty() {
            if let Some(d) = parse_duration_string(&v).filter(|d| *d > 0.0) {
                return (d as i64).max(1);
            }
        }
    }
    let body = err.body();
    if body.is_empty() {
        return 0;
    }
    if let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(body) {
        let error_dict = match payload.get("error") {
            Some(Value::Object(e)) => e.clone(),
            _ => payload.clone(),
        };
        if let Some(Value::Array(details)) = error_dict.get("details") {
            for item in details {
                if let Some(Value::Object(meta)) = item.get("metadata") {
                    if let Some(Value::String(d)) = meta.get("retryDelay") {
                        if let Some(dur) = parse_duration_string(d).filter(|d| *d > 0.0) {
                            return (dur as i64).max(1);
                        }
                    }
                    if let Some(q) = meta.get("quotaResetTimeStamp").filter(|v| crate::util::truthy(v)) {
                        if let Some(ts) = parse_reset_value(q).filter(|t| *t > 0) {
                            return ts;
                        }
                    }
                }
            }
        }
        for key in ["reset_after_seconds", "reset_after", "reset_at", "resets_at"] {
            if let Some(v) = error_dict.get(key).filter(|v| !v.is_null()) {
                if let Some(ts) = parse_reset_value(v).filter(|t| *t > 0) {
                    return ts;
                }
            }
        }
    }
    static RD: OnceLock<Regex> = OnceLock::new();
    if let Some(c) = RD.get_or_init(|| Regex::new(r#""retryDelay"\s*:\s*"(\d+)s""#).unwrap()).captures(body) {
        return c[1].parse().unwrap_or(0);
    }
    static FB: OnceLock<Regex> = OnceLock::new();
    let fb = FB.get_or_init(|| Regex::new(r"(?i)(?:try again in|resets?\s+(?:in|after)|reset\s+after|retry\s+after|wait)\s+([0-9a-zA-Z\s\.,]+)").unwrap());
    for c in fb.captures_iter(body) {
        if let Some(d) = parse_duration_string(&c[1]).filter(|d| *d > 0.0) {
            return (d as i64).max(1);
        }
    }
    parse_time_after(body).filter(|t| *t > 0).unwrap_or(0)
}

/// `_extract_provider_error_message`.
pub fn extract_provider_error_message(body: &str) -> Option<String> {
    let data: Value = serde_json::from_str(body).ok()?;
    let obj = data.as_object()?;
    match obj.get("error") {
        Some(Value::Object(e)) => {
            if let Some(msg) = e.get("message").and_then(|m| m.as_str()).map(str::trim).filter(|m| !m.is_empty()) {
                if let Some(t) = e.get("type").and_then(|t| t.as_str()).map(str::trim).filter(|t| !t.is_empty()) {
                    return Some(format!("{t}: {msg}"));
                }
                return Some(msg.to_string());
            }
        }
        Some(Value::String(s)) if !s.trim().is_empty() => return Some(s.trim().to_string()),
        _ => {}
    }
    for key in ["message", "detail"] {
        if let Some(s) = obj.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
            return Some(s.to_string());
        }
    }
    None
}

/// `blames_the_model`.
pub fn blames_the_model(detail: Option<&str>) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| {
        Regex::new(r"(?is)\bmodel\b.*\b(not supported|unsupported|unavailable|not available|does not exist|not found|no access|decommissioned|deprecated|retired)\b").unwrap()
    });
    detail.map(|d| !d.is_empty() && re.is_match(d)).unwrap_or(false)
}

/// `classify_provider_http_error`.
pub fn classify_http(status: u16, body: &str, label: &str) -> AgentError {
    let detail = extract_provider_error_message(body);
    let suffix = detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default();
    let punct = match &detail {
        Some(d) if d.ends_with('.') || d.ends_with('!') || d.ends_with('?') => "",
        _ => ".",
    };
    if (status == 401 || status == 403) && !blames_the_model(detail.as_deref()) {
        return AgentError::Auth {
            message: format!("{label} rejected the request — authentication failed (HTTP {status}){suffix}{punct} Check the provider's API key / login in Settings → Providers."),
            status: Some(status),
            provider: Some(label.to_string()),
        };
    }
    AgentError::Request { message: format!("{label} rejected the request (HTTP {status}){suffix}{punct}"), status: Some(status), provider: Some(label.to_string()) }
}

/// httpx exception class name for a transport failure (logging / events).
pub fn network_error_type(msg: &str) -> &'static str {
    let m = msg.to_lowercase();
    if m.contains("timed out") || m.contains("timeout") {
        "ReadTimeout"
    } else if m.contains("connect") || m.contains("dns") || m.contains("refused") {
        "ConnectError"
    } else {
        "RemoteProtocolError"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration_string("6m0s"), Some(360.0));
        assert_eq!(parse_duration_string("2 hours 15 minutes"), Some(8100.0));
        assert_eq!(parse_duration_string("11.054s"), Some(11.054));
        assert_eq!(parse_duration_string("nothing"), None);
        assert_eq!(format_duration(8100.0), "2h 15m");
        assert_eq!(format_duration(2710.0), "45m 10s");
        assert_eq!(format_duration(30.0), "30s");
        assert_eq!(format_duration(90000.0), "1d 1h");
    }

    #[test]
    fn retry_after_sources() {
        let e = ProviderError::http(429, "u", "".into(), vec![("Retry-After".into(), "7".into())]);
        assert_eq!(parse_retry_after(&e), 7);
        let e = ProviderError::http(429, "u", r#"{"error":{"message":"Please try again in 20s."}}"#.into(), vec![]);
        assert_eq!(parse_retry_after(&e), 20);
        assert!(is_retryable_http(503, ""));
        assert!(!is_retryable_http(501, ""));
        assert!(!is_retryable_http(400, ""));
    }

    #[test]
    fn classify() {
        let e = classify_http(401, r#"{"error":{"message":"bad key","type":"auth"}}"#, "openai:gpt");
        assert_eq!(
            e.to_string(),
            "openai:gpt rejected the request — authentication failed (HTTP 401): auth: bad key. Check the provider's API key / login in Settings → Providers."
        );
        let e = classify_http(401, r#"{"error":"model not supported"}"#, "x");
        assert!(matches!(e, AgentError::Request { .. }));
    }
}
