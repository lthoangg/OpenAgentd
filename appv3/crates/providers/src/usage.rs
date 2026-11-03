//! Token-usage accounting and cost computation.

use crate::registry::get_model_cost_at;
use crate::types::Usage;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

/// The largest `Retry-After` wait, in seconds, whose deadline (`now` + wait)
/// is still representable: Unix time up to `DateTime::<Utc>::MAX_UTC`
/// (year 262142, 8_210_298_412_799 s). That deadline also fits a JS `Date`
/// and a JS safe integer, in seconds or milliseconds, and `chrono`
/// arithmetic cannot overflow on it. It is centuries beyond any real wait.
pub fn max_retry_after_secs(now: DateTime<Utc>) -> u64 {
    DateTime::<Utc>::MAX_UTC.timestamp().saturating_sub(now.timestamp()).max(0) as u64
}

/// Seconds to wait from a `Retry-After` value: delta-seconds (a plain
/// decimal; a fraction rounds up, never down) or an HTTP-date (IMF-fixdate,
/// RFC 850 or asctime, all GMT; a past date is 0). Accepted waits are never
/// shortened or capped. Empty, signed, exponent, non-finite, non-ASCII,
/// malformed values, and waits beyond `max_retry_after_secs(now)` (an
/// unrepresentable deadline) give `None`.
pub fn parse_retry_after(value: &str, now: DateTime<Utc>) -> Option<u64> {
    parse_wait(value, now).filter(|s| *s <= max_retry_after_secs(now))
}

fn parse_wait(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(v) {
        return v.parse().ok();
    }
    if let Some((whole, frac)) = v.split_once('.') {
        if !(digits(whole) && digits(frac)) {
            return None;
        }
        let secs = v.parse::<f64>().ok()?.ceil();
        // 2^64 is the first value a u64 cannot hold.
        return (secs.is_finite() && secs < 18_446_744_073_709_551_616.0).then_some(secs as u64);
    }
    let when = ["%a, %d %b %Y %H:%M:%S GMT", "%A, %d-%b-%y %H:%M:%S GMT", "%a %b %e %H:%M:%S %Y"].iter().find_map(|f| chrono::NaiveDateTime::parse_from_str(v, f).ok())?;
    let millis = when.and_utc().signed_duration_since(now).num_milliseconds();
    Some(if millis <= 0 { 0 } else { (millis as u64).div_ceil(1000) })
}

/// The longest valid `Retry-After` among `(name, value)` header pairs.
pub fn retry_after_from_pairs<'a>(headers: impl IntoIterator<Item = (&'a str, &'a str)>, now: DateTime<Utc>) -> Option<u64> {
    headers.into_iter().filter(|(k, _)| k.eq_ignore_ascii_case("retry-after")).filter_map(|(_, v)| parse_retry_after(v, now)).max()
}

/// `retry_after_from_pairs` over a response's header map, using the clock.
pub fn retry_after_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let now = Utc::now();
    headers.get_all(reqwest::header::RETRY_AFTER).iter().filter_map(|v| parse_retry_after(v.to_str().ok()?, now)).max()
}

/// The usage error for a failed (status >= 400) provider response. Reads the
/// status and headers only, so call it before the body is consumed. A 429
/// keeps just its `Retry-After`; nothing else from the response is carried.
pub(crate) fn usage_http_error(resp: &reqwest::Response, url: &str) -> crate::codex::UsageError {
    use crate::codex::UsageError;
    let status = resp.status().as_u16();
    if matches!(status, 401 | 403) {
        return UsageError::Credentials("Provider credentials were rejected.".into());
    }
    if status == 429 {
        return UsageError::RateLimited { retry_after: retry_after_from_headers(resp.headers()) };
    }
    UsageError::Unavailable(crate::plugin::http_status_message(status, url))
}

pub fn usage_to_dict(usage: &Usage, model_id: Option<&str>) -> Value {
    let mut r = Map::new();
    r.insert("input".into(), json!(usage.prompt_tokens));
    r.insert("output".into(), json!(usage.completion_tokens));
    if let Some(v) = usage.cached_tokens {
        r.insert("cache".into(), json!(v));
    }
    if let Some(v) = usage.cache_write_tokens {
        r.insert("cache_write".into(), json!(v));
    }
    if let Some(v) = usage.thoughts_tokens {
        r.insert("thoughts".into(), json!(v));
    }
    if let Some(v) = usage.tool_use_tokens {
        r.insert("tool_use".into(), json!(v));
    }
    // Usage is priced as the reply finishes, and the estimate is stored with
    // it, so the clock gives the rate in effect (DeepSeek's off-peak hours).
    if let Some(cost) = estimate_cost_at(usage, model_id, Utc::now()) {
        r.insert("cost".into(), cost);
    }
    Value::Object(r)
}

fn estimate_cost_at(usage: &Usage, model_id: Option<&str>, at: DateTime<Utc>) -> Option<Value> {
    let prices = get_model_cost_at(model_id, at);
    let mut comps: Vec<(&str, f64)> = vec![];
    let cached = usage.cached_tokens.unwrap_or(0);
    let cw = usage.cache_write_tokens.unwrap_or(0);
    let mut input = usage.prompt_tokens;
    if let (Some(p), true) = (prices.cache_read, cached > 0) {
        comps.push(("cache_read_usd", cached as f64 * p / 1_000_000.0));
        input -= cached;
    }
    if let (Some(p), true) = (prices.cache_write, cw > 0) {
        comps.push(("cache_write_usd", cw as f64 * p / 1_000_000.0));
        input -= cw;
    }
    let input = input.max(0);
    if let (Some(p), true) = (prices.input, input > 0) {
        comps.push(("input_usd", input as f64 * p / 1_000_000.0));
    }
    if let (Some(p), true) = (prices.output, usage.completion_tokens > 0) {
        comps.push(("output_usd", usage.completion_tokens as f64 * p / 1_000_000.0));
    }
    if comps.is_empty() {
        return None;
    }
    // Python dict order: estimated_usd first, then components in insertion order.
    let total = appv3_core::pymath::py_sum(comps.iter().map(|(_, v)| *v));
    let mut m = Map::new();
    m.insert("estimated_usd".into(), json!(total));
    for (k, v) in comps {
        m.insert(k.into(), json!(v));
    }
    Some(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2015, 10, 21, h, m, s).unwrap()
    }

    #[test]
    fn retry_after_seconds_are_honored_whole() {
        let now = at(7, 25, 12);
        for (raw, want) in [("120", 120), (" 7 ", 7), ("0", 0), ("188", 188), ("604800", 604_800), ("86400000", 86_400_000), ("31536000000", 31_536_000_000)] {
            assert_eq!(parse_retry_after(raw, now), Some(want), "{raw:?}");
        }
    }

    #[test]
    fn a_wait_is_accepted_exactly_while_its_deadline_is_representable() {
        let now = at(7, 25, 12);
        let max = max_retry_after_secs(now);
        // The deadline is a Unix time that fits chrono, JS Date and a JS safe integer, in s and ms.
        let deadline = now.timestamp() as u64 + max;
        assert_eq!(deadline as i64, DateTime::<Utc>::MAX_UTC.timestamp());
        // JS Date's limit (8.64e15 ms) is the tighter one, and it is below 2^53 - 1.
        assert!(deadline * 1000 <= 8_640_000_000_000_000);
        assert!(max > 100 * 365 * 86_400, "far more than any real wait: {max}");
        assert_eq!(parse_retry_after(&max.to_string(), now), Some(max));
        assert_eq!(parse_retry_after(&format!("{max}.0"), now), Some(max));
        assert_eq!(parse_retry_after(&(max + 1).to_string(), now), None);
        assert_eq!(parse_retry_after(&format!("{max}.5"), now), None, "a fraction never rounds past the bound");
        for raw in ["18446744073709551615", "9007199254740991", "9007199254740992", "9223372036854775807", "9223372036854775808"] {
            assert_eq!(parse_retry_after(raw, now), None, "{raw}");
        }
        // The bound moves with the clock: a later `now` leaves less room.
        assert!(max_retry_after_secs(now + chrono::Duration::days(1)) < max);
    }

    #[test]
    fn fractional_retry_after_rounds_up_never_down() {
        let now = at(7, 25, 12);
        for (raw, want) in [("1.5", 2), ("0.2", 1), ("3.0", 3), ("187.0001", 188)] {
            assert_eq!(parse_retry_after(raw, now), Some(want), "{raw:?}");
        }
    }

    #[test]
    fn invalid_negative_nonfinite_and_overflowing_retry_after_is_rejected() {
        let now = at(7, 25, 12);
        for raw in [
            "",
            "  ",
            "abc",
            "-1",
            "-0",
            "-1.5",
            "+5",
            "NaN",
            "nan",
            "inf",
            "Infinity",
            "-inf",
            "1e3",
            "1E3",
            "1.5.2",
            ".5",
            "5.",
            "5s",
            "0x10",
            "5, 10",
            "٣",
            "18446744073709551616",
            "99999999999999999999999",
            "18446744073709551616.0",
            "18446744073709551615.5",
            "Wed, 32 Oct 2015 07:28:00 GMT",
            "Wed, 21 Oct 2015 07:28:00 +0200",
            "Thu, 21 Oct 2015 07:28:00 GMT",
            "tomorrow",
        ] {
            assert_eq!(parse_retry_after(raw, now), None, "{raw:?}");
        }
    }

    #[test]
    fn http_date_retry_after_in_all_three_formats() {
        let now = at(7, 25, 12);
        for raw in ["Wed, 21 Oct 2015 07:28:00 GMT", "Wednesday, 21-Oct-15 07:28:00 GMT", "Wed Oct 21 07:28:00 2015"] {
            assert_eq!(parse_retry_after(raw, now), Some(168), "{raw:?}");
        }
        let part_second = at(7, 25, 12) + chrono::Duration::milliseconds(400);
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", part_second), Some(168), "167.6s rounds up");
    }

    #[test]
    fn http_date_in_the_past_means_no_wait() {
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", at(9, 0, 0)), Some(0));
    }

    #[test]
    fn header_pairs_match_the_name_case_insensitively_and_keep_the_longest_valid_wait() {
        let now = at(7, 25, 12);
        assert_eq!(retry_after_from_pairs([("content-type", "text/plain"), ("RETRY-AFTER", "30")], now), Some(30));
        assert_eq!(retry_after_from_pairs([("Retry-After", "30"), ("retry-after", "900"), ("retry-after", "nope")], now), Some(900));
        assert_eq!(retry_after_from_pairs([("retry-after", "-3"), ("x-retry-after", "60")], now), None);
        assert_eq!(retry_after_from_pairs([("content-type", "text/plain")], now), None);
    }

    #[test]
    fn header_map_wait_uses_every_value() {
        let mut h = reqwest::header::HeaderMap::new();
        h.append("retry-after", "10".parse().unwrap());
        h.append("retry-after", "250".parse().unwrap());
        assert_eq!(retry_after_from_headers(&h), Some(250));
        assert_eq!(retry_after_from_headers(&reqwest::header::HeaderMap::new()), None);
    }

    /// One real HTTP exchange: the response a provider's usage call would see.
    async fn respond(status_line: &str, headers: &str, body: &str) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let raw = format!("HTTP/1.1 {status_line}\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let mut got = 0;
            while !String::from_utf8_lossy(&buf[..got]).contains("\r\n\r\n") {
                let n = s.read(&mut buf[got..]).await.unwrap();
                if n == 0 {
                    break;
                }
                got += n;
            }
            s.write_all(raw.as_bytes()).await.unwrap();
            let _ = s.shutdown().await;
        });
        reqwest::Client::new().get(format!("http://{addr}/usage")).send().await.unwrap()
    }

    #[tokio::test]
    async fn a_429_response_carries_only_its_retry_after() {
        use crate::codex::UsageError;
        let body = r#"{"error":"sk-secret-body"}"#;
        let r = respond("429 Too Many Requests", "retry-after: 188\r\nset-cookie: session=secret\r\n", body).await;
        let e = usage_http_error(&r, "https://example.test/usage");
        assert_eq!(e, UsageError::RateLimited { retry_after: Some(188) });
        assert!(!format!("{e:?}").contains("secret"));
    }

    #[tokio::test]
    async fn a_429_without_a_usable_retry_after_is_still_rate_limited() {
        use crate::codex::UsageError;
        for headers in ["", "retry-after: soon\r\n", "retry-after: -5\r\n"] {
            let r = respond("429 Too Many Requests", headers, "{}").await;
            assert_eq!(usage_http_error(&r, "https://example.test/usage"), UsageError::RateLimited { retry_after: None }, "{headers:?}");
        }
    }

    #[tokio::test]
    async fn rejected_credentials_are_a_credential_error_not_an_outage() {
        use crate::codex::UsageError;
        for status_line in ["401 Unauthorized", "403 Forbidden"] {
            let r = respond(status_line, "retry-after: 30\r\n", "sk-secret token expired").await;
            let e = usage_http_error(&r, "https://example.test/usage");
            assert_eq!(e, UsageError::Credentials("Provider credentials were rejected.".into()), "{status_line}");
            assert!(!format!("{e:?}").contains("secret"));
        }
    }

    #[tokio::test]
    async fn other_failures_stay_unavailable_even_with_retry_after() {
        use crate::codex::UsageError;
        let r = respond("503 Service Unavailable", "retry-after: 30\r\n", "oops sk-secret").await;
        let e = usage_http_error(&r, "https://example.test/usage");
        let UsageError::Unavailable(m) = e else { panic!("{e:?}") };
        assert!(m.contains("503") && !m.contains("secret"), "{m}");
    }

    #[test]
    fn deepseek_replies_cost_half_off_peak() {
        let usage = Usage { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000, cached_tokens: Some(500_000), ..Default::default() };
        let model = Some("deepseek:deepseek-flash");
        // Monday 03:00 UTC (peak), then Saturday 03:00 UTC (off-peak).
        let peak = estimate_cost_at(&usage, model, Utc.with_ymd_and_hms(2026, 10, 26, 3, 0, 0).unwrap()).unwrap();
        let off = estimate_cost_at(&usage, model, Utc.with_ymd_and_hms(2026, 10, 24, 3, 0, 0).unwrap()).unwrap();
        // 0.5M cached × 0.006 + 0.5M uncached × 0.30 + 1M output × 1.20.
        assert!((peak["estimated_usd"].as_f64().unwrap() - 1.353).abs() < 1e-12, "{peak}");
        assert!((off["estimated_usd"].as_f64().unwrap() - 0.6765).abs() < 1e-12, "{off}");
    }
}
