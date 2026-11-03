//! Next-fire calculator (croniter-compatible semantics:
//! 5 fields, optional 6th seconds field, `@daily` aliases, `L` day-of-month,
//! `dow#n`, day-of-month/day-of-week OR when both are restricted).

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone)]
struct Field {
    allowed: Vec<bool>,
    star: bool,
}

#[derive(Debug, Clone)]
pub struct CronExpr {
    minute: Field,
    hour: Field,
    dom: Field,
    dom_last: bool,
    month: Field,
    dow: Field,
    dow_nth: Vec<(u32, u32)>,
    second: Option<Field>,
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn name_value(tok: &str, names: &[&str], offset: u32) -> Option<u32> {
    let t = tok.to_ascii_lowercase();
    names.iter().position(|n| *n == t).map(|i| i as u32 + offset).or_else(|| tok.parse().ok())
}

fn parse_field(spec: &str, min: u32, max: u32, names: Option<(&[&str], u32)>) -> Option<Field> {
    let mut allowed = vec![false; (max + 1) as usize];
    let star = spec == "*" || spec == "?";
    for part in spec.split(',') {
        if part.is_empty() {
            return None;
        }
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => (r, s.parse::<u32>().ok().filter(|s| *s > 0)?),
            None => (part, 1),
        };
        let val = |t: &str| -> Option<u32> {
            match names {
                Some((n, off)) => name_value(t, n, off),
                None => t.parse().ok(),
            }
        };
        let (lo, hi) = if range == "*" || range == "?" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (val(a)?, val(b)?)
        } else {
            let v = val(range)?;
            if part.contains('/') {
                (v, max)
            } else {
                (v, v)
            }
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            allowed[v as usize] = true;
            v += step;
        }
    }
    Some(Field { allowed, star })
}

impl CronExpr {
    pub fn parse(expr: &str) -> Option<Self> {
        let e = expr.trim();
        let expanded = match e.to_ascii_lowercase().as_str() {
            "@yearly" | "@annually" => "0 0 1 1 *".to_string(),
            "@monthly" => "0 0 1 * *".to_string(),
            "@weekly" => "0 0 * * 0".to_string(),
            "@daily" | "@midnight" => "0 0 * * *".to_string(),
            "@hourly" => "0 * * * *".to_string(),
            _ => e.to_string(),
        };
        let parts: Vec<&str> = expanded.split_whitespace().collect();
        if parts.len() != 5 && parts.len() != 6 {
            return None;
        }
        let minute = parse_field(parts[0], 0, 59, None)?;
        let hour = parse_field(parts[1], 0, 23, None)?;
        let (dom_spec, dom_last) = {
            let items: Vec<&str> = parts[2].split(',').collect();
            let last = items.iter().any(|x| x.eq_ignore_ascii_case("l"));
            let rest: Vec<&str> = items.into_iter().filter(|x| !x.eq_ignore_ascii_case("l")).collect();
            (if rest.is_empty() { None } else { Some(rest.join(",")) }, last)
        };
        let dom = match dom_spec {
            Some(s) => parse_field(&s, 1, 31, None)?,
            None => Field { allowed: vec![false; 32], star: false },
        };
        let month = parse_field(parts[3], 1, 12, Some((&MONTHS, 1)))?;
        let mut dow_nth = vec![];
        let mut plain = vec![];
        for item in parts[4].split(',') {
            if let Some((d, n)) = item.split_once('#') {
                let d = name_value(d, &DAYS, 0)? % 7;
                let n: u32 = n.parse().ok().filter(|n| (1..=5).contains(n))?;
                dow_nth.push((d, n));
            } else {
                plain.push(item);
            }
        }
        let mut dow = if plain.is_empty() { Field { allowed: vec![false; 8], star: false } } else { parse_field(&plain.join(","), 0, 7, Some((&DAYS, 0)))? };
        if dow.allowed[7] {
            dow.allowed[0] = true;
        }
        let second = if parts.len() == 6 { Some(parse_field(parts[5], 0, 59, None)?) } else { None };
        Some(Self { minute, hour, dom, dom_last, month, dow, dow_nth, second })
    }

    fn day_matches(&self, d: NaiveDate) -> bool {
        let last_day = last_day_of_month(d.year(), d.month());
        let dom_ok = self.dom.allowed[d.day() as usize] || (self.dom_last && d.day() == last_day);
        let wd = d.weekday().num_days_from_sunday();
        let nth = (d.day() - 1) / 7 + 1;
        let dow_ok = self.dow.allowed[wd as usize] || self.dow_nth.iter().any(|(w, n)| *w == wd && *n == nth);
        let dom_star = self.dom.star && !self.dom_last;
        let dow_star = self.dow.star && self.dow_nth.is_empty();
        match (dom_star, dow_star) {
            (true, true) => true,
            (true, false) => dow_ok,
            (false, true) => dom_ok,
            (false, false) => dom_ok || dow_ok,
        }
    }

    /// Next local wall-clock time strictly after `after` (croniter `get_next`).
    pub fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let step_secs = self.second.is_some();
        let mut t = if step_secs { after.with_nanosecond(0)? + Duration::seconds(1) } else { after.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1) };
        let limit = after + Duration::days(366 * 5);
        while t <= limit {
            if !self.month.allowed[t.month() as usize] {
                let (y, m) = if t.month() == 12 { (t.year() + 1, 1) } else { (t.year(), t.month() + 1) };
                t = NaiveDate::from_ymd_opt(y, m, 1)?.and_hms_opt(0, 0, 0)?;
                continue;
            }
            if !self.day_matches(t.date()) {
                t = (t.date() + Duration::days(1)).and_hms_opt(0, 0, 0)?;
                continue;
            }
            if !self.hour.allowed[t.hour() as usize] {
                t = t.date().and_hms_opt(t.hour(), 0, 0)? + Duration::hours(1);
                continue;
            }
            if !self.minute.allowed[t.minute() as usize] {
                t = t.date().and_hms_opt(t.hour(), t.minute(), 0)? + Duration::minutes(1);
                continue;
            }
            if let Some(s) = &self.second {
                if !s.allowed[t.second() as usize] {
                    t += Duration::seconds(1);
                    continue;
                }
            }
            return Some(t);
        }
        None
    }
}

fn last_day_of_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (NaiveDate::from_ymd_opt(ny, nm, 1).unwrap() - Duration::days(1)).day()
}

pub fn validate_cron(expr: &str) -> bool {
    CronExpr::parse(expr).is_some()
}

pub fn parse_tz(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

/// `next_fire`.
pub fn next_fire(
    schedule_type: &str,
    cron_expression: Option<&str>,
    every_seconds: Option<i64>,
    at_datetime: Option<DateTime<Utc>>,
    timezone: &str,
    after: Option<DateTime<Utc>>,
    run_count: i64,
) -> Option<DateTime<Utc>> {
    let now = after.unwrap_or_else(Utc::now);
    match schedule_type {
        "at" => {
            if run_count > 0 {
                return None;
            }
            at_datetime
        }
        "every" => {
            let s = every_seconds.filter(|s| *s > 0)?;
            Some(now + Duration::seconds(s))
        }
        "cron" => {
            let expr = cron_expression.filter(|e| !e.is_empty())?;
            let c = CronExpr::parse(expr)?;
            let tz = parse_tz(timezone).unwrap_or(chrono_tz::UTC);
            let base = now.with_timezone(&tz).naive_local();
            let mut cand = c.next_after(base)?;
            for _ in 0..10_000 {
                match tz.from_local_datetime(&cand) {
                    chrono::LocalResult::Single(d) => return Some(d.with_timezone(&Utc)),
                    chrono::LocalResult::Ambiguous(a, _) => return Some(a.with_timezone(&Utc)),
                    chrono::LocalResult::None => cand = c.next_after(cand)?,
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn cron_matches_croniter() {
        let a = utc("2026-01-05T08:59:30Z"); // Monday
        assert_eq!(next_fire("cron", Some("0 9 * * 1-5"), None, None, "UTC", Some(a), 0), Some(utc("2026-01-05T09:00:00Z")));
        assert_eq!(next_fire("cron", Some("*/15 * * * *"), None, None, "UTC", Some(a), 0), Some(utc("2026-01-05T09:00:00Z")));
        assert_eq!(next_fire("cron", Some("0 9 * * *"), None, None, "Asia/Ho_Chi_Minh", Some(a), 0), Some(utc("2026-01-06T02:00:00Z")));
        assert_eq!(next_fire("cron", Some("@daily"), None, None, "UTC", Some(a), 0), Some(utc("2026-01-06T00:00:00Z")));
        assert_eq!(next_fire("cron", Some("0 0 L * *"), None, None, "UTC", Some(a), 0), Some(utc("2026-01-31T00:00:00Z")));
        assert_eq!(next_fire("every", None, Some(30), None, "UTC", Some(a), 0), Some(utc("2026-01-05T09:00:00Z")));
        assert_eq!(next_fire("at", None, None, Some(a), "UTC", None, 1), None);
        assert!(!validate_cron("61 * * * *"));
        assert!(!validate_cron("* * *"));
        assert!(validate_cron("0 0 * * MON#2"));
    }
}
