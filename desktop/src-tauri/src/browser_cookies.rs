//! Reading a cookie export the user pasted, for the Preview tab's profile.
//!
//! Some sites refuse to sign in inside an embedded browser. The user can
//! then export that site's cookies from a browser where they are signed in
//! and paste the export into **Import cookies**. Two formats are read: the
//! JSON list browser extensions write (and Playwright's `cookies` list),
//! and Netscape `cookies.txt`.
//!
//! This module only parses and filters. Cookie values are secrets: nothing
//! here logs them or puts one into an error message.

use serde_json::Value;
use tauri::webview::cookie::time::OffsetDateTime;
use tauri::webview::cookie::SameSite;
use tauri::webview::Cookie;

/// Largest export read, and most cookies taken from one.
pub const MAX_EXPORT_BYTES: usize = 1024 * 1024;
pub const MAX_COOKIES: usize = 2000;
const MAX_NAME_BYTES: usize = 256;
const MAX_VALUE_BYTES: usize = 8192;

/// One cookie of an export.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedCookie {
    pub name: String,
    pub value: String,
    /// Lower case, without a leading dot.
    pub domain: String,
    /// The export had the domain with a leading dot (or said so): the
    /// cookie is also sent to subdomains.
    pub subdomains: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<Site>,
    /// Seconds since 1970; `None` for a cookie that ends with the session.
    pub expires: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Site {
    Strict,
    Lax,
    None,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME_BYTES && name.bytes().all(|b| b.is_ascii_graphic() && !b"()<>@,;:\\\"/[]?={}".contains(&b))
}

fn valid_value(value: &str) -> bool {
    value.len() <= MAX_VALUE_BYTES && value.bytes().all(|b| (0x21..0x7f).contains(&b) && b != b';' && b != b',' && b != b'\\' && b != b'"')
}

/// `domain` as a host: lower case, no leading dot, labels of letters,
/// digits and hyphens. An IP address or a single label is a host too.
fn host_of(domain: &str) -> Option<String> {
    let host = domain.trim().trim_start_matches('.').trim_end_matches('.').to_ascii_lowercase();
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    (!host.is_empty() && host.len() <= 253 && host.split('.').all(label_ok)).then_some(host)
}

/// `raw`, a cookie as an export wrote it, checked and normalized; `None`
/// when it is not one this app can store.
fn checked(raw: ImportedCookie) -> Option<ImportedCookie> {
    let path = if raw.path.is_empty() { "/".to_string() } else { raw.path };
    let path_ok = path.starts_with('/') && path.len() <= 1024 && path.bytes().all(|b| (0x20..0x7f).contains(&b) && b != b';');
    if !valid_name(&raw.name) || !valid_value(&raw.value) || !path_ok {
        return None;
    }
    Some(ImportedCookie {
        subdomains: raw.subdomains || raw.domain.trim().starts_with('.'),
        domain: host_of(&raw.domain)?,
        path,
        expires: raw.expires.filter(|&at| at > 0),
        ..raw
    })
}

fn json_cookie(entry: &Value) -> Option<ImportedCookie> {
    let text = |key: &str| entry.get(key).and_then(Value::as_str);
    let flag = |key: &str| entry.get(key).and_then(Value::as_bool).unwrap_or(false);
    let same_site = match text("sameSite").map(str::to_ascii_lowercase).as_deref() {
        Some("strict") => Some(Site::Strict),
        Some("lax") => Some(Site::Lax),
        Some("none" | "no_restriction") => Some(Site::None),
        _ => None,
    };
    // Extensions write `expirationDate`; Playwright writes `expires`, with -1 for a session cookie.
    let expires = if flag("session") { None } else { entry.get("expirationDate").or_else(|| entry.get("expires")).and_then(Value::as_f64).map(|at| at as i64) };
    let subdomains = entry.get("hostOnly").and_then(Value::as_bool).map(|host_only| !host_only).unwrap_or(false);
    checked(ImportedCookie {
        name: text("name")?.to_string(),
        value: text("value").unwrap_or("").to_string(),
        domain: text("domain")?.to_string(),
        subdomains,
        path: text("path").unwrap_or("/").to_string(),
        secure: flag("secure"),
        http_only: flag("httpOnly"),
        same_site,
        expires,
    })
}

/// A line of `cookies.txt`: domain, subdomains flag, path, secure flag,
/// expiry and name, then the value, separated by tabs. `#HttpOnly_` in
/// front of the domain marks an HttpOnly cookie; any other `#` line is a
/// comment.
fn netscape_cookie(line: &str) -> Option<ImportedCookie> {
    let (line, http_only) = match line.strip_prefix("#HttpOnly_") {
        Some(rest) => (rest, true),
        None if line.starts_with('#') => return None,
        None => (line, false),
    };
    let fields: Vec<&str> = line.split('\t').collect();
    let [domain, subdomains, path, secure, expires, name, value] = fields.as_slice() else { return None };
    let yes = |field: &str| field.eq_ignore_ascii_case("TRUE");
    checked(ImportedCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: domain.to_string(),
        subdomains: yes(subdomains),
        path: path.to_string(),
        secure: yes(secure),
        http_only,
        same_site: None,
        expires: expires.trim().parse::<i64>().ok(),
    })
}

/// The cookies in `text` and how many of its entries were not cookies this
/// app can store. An export that is neither format is an error.
pub fn parse_export(text: &str) -> Result<(Vec<ImportedCookie>, usize), String> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err("That export is too large (over 1 MB). Export the cookies of one site.".to_string());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste a cookie export first.".to_string());
    }
    let mut cookies = Vec::new();
    let mut unreadable = 0;
    let mut take = |cookie: Option<ImportedCookie>| match cookie {
        Some(cookie) if cookies.len() < MAX_COOKIES => cookies.push(cookie),
        _ => unreadable += 1,
    };
    if text.starts_with('[') || text.starts_with('{') {
        let json: Value = serde_json::from_str(text).map_err(|_| "That is not a cookie export: the JSON could not be read.".to_string())?;
        let list = match &json {
            Value::Array(list) => list,
            Value::Object(map) => map.get("cookies").and_then(Value::as_array).ok_or_else(|| "That JSON has no list of cookies.".to_string())?,
            _ => unreachable!("text starts with [ or {{"),
        };
        for entry in list {
            take(json_cookie(entry));
        }
    } else {
        for line in text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()) {
            if line.starts_with('#') && !line.starts_with("#HttpOnly_") {
                continue;
            }
            take(netscape_cookie(line));
        }
    }
    if cookies.is_empty() {
        return Err("No cookies were found. Paste a JSON export from a cookie extension, or a cookies.txt file.".to_string());
    }
    Ok((cookies, unreadable))
}

/// Is a cookie for `domain` one of the site the page on `host` belongs to?
/// The host itself, a subdomain of the site (`host` without `www.`), or a
/// parent domain of the host with at least two labels.
pub fn belongs_to(domain: &str, host: &str) -> bool {
    let site = host.strip_prefix("www.").unwrap_or(host);
    let under = |child: &str, parent: &str| child.len() > parent.len() && child.ends_with(parent) && child.as_bytes()[child.len() - parent.len() - 1] == b'.';
    domain == host || domain == site || under(domain, site) || (domain.contains('.') && under(host, domain))
}

impl ImportedCookie {
    /// The cookie as the webview stores it.
    pub fn to_cookie(&self) -> Cookie<'static> {
        // A leading dot is how the store learns the cookie covers
        // subdomains. The cookie type drops one leading dot when the
        // webview reads the domain back, hence two.
        let domain = if self.subdomains { format!("..{}", self.domain) } else { self.domain.clone() };
        let mut cookie = Cookie::build((self.name.clone(), self.value.clone())).domain(domain).path(self.path.clone()).secure(self.secure).http_only(self.http_only);
        if let Some(same_site) = self.same_site {
            cookie = cookie.same_site(match same_site {
                Site::Strict => SameSite::Strict,
                Site::Lax => SameSite::Lax,
                Site::None => SameSite::None,
            });
        }
        if let Some(at) = self.expires.and_then(|at| OffsetDateTime::from_unix_timestamp(at).ok()) {
            cookie = cookie.expires(at);
        }
        cookie.build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"[
      {"domain": ".example.com", "expirationDate": 1893456000.5, "hostOnly": false, "httpOnly": true, "name": "sid", "path": "/", "sameSite": "lax", "secure": true, "session": false, "value": "abc123"},
      {"domain": "app.example.com", "hostOnly": true, "name": "theme", "value": "dark", "session": true, "expirationDate": 1893456000},
      {"domain": "other.test", "name": "x", "value": "1", "sameSite": "no_restriction"},
      {"name": "no-domain", "value": "1"},
      {"domain": "example.com", "name": "bad name", "value": "1"},
      "not an object"
    ]"#;

    #[test]
    fn a_json_export_is_read_and_bad_entries_are_counted() {
        let (cookies, unreadable) = parse_export(JSON).unwrap();
        assert_eq!(unreadable, 3);
        assert_eq!(cookies.len(), 3);
        let sid = &cookies[0];
        assert_eq!((sid.name.as_str(), sid.value.as_str(), sid.domain.as_str()), ("sid", "abc123", "example.com"));
        assert!(sid.subdomains && sid.secure && sid.http_only);
        assert_eq!(sid.same_site, Some(Site::Lax));
        assert_eq!(sid.expires, Some(1893456000));
        assert_eq!(cookies[1].expires, None, "a session cookie has no expiry");
        assert!(!cookies[1].subdomains);
        assert_eq!(cookies[2].same_site, Some(Site::None));
        // Playwright's storage state: an object with the list, -1 for a session cookie.
        let (cookies, _) = parse_export(r#"{"cookies": [{"name": "a", "value": "b", "domain": "example.com", "path": "/x", "expires": -1}]}"#).unwrap();
        assert_eq!((cookies[0].path.as_str(), cookies[0].expires), ("/x", None));
    }

    #[test]
    fn a_cookies_txt_export_is_read() {
        let text = "# Netscape HTTP Cookie File\n# a comment\n\n.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tabc123\n#HttpOnly_app.example.com\tFALSE\t/account\tFALSE\t0\ttoken\txyz\nbroken line\n";
        let (cookies, unreadable) = parse_export(text).unwrap();
        assert_eq!(unreadable, 1);
        assert_eq!(cookies.len(), 2);
        assert!(cookies[0].subdomains && cookies[0].secure && !cookies[0].http_only);
        assert_eq!(cookies[0].expires, Some(1893456000));
        let token = &cookies[1];
        assert_eq!((token.domain.as_str(), token.path.as_str(), token.expires), ("app.example.com", "/account", None));
        assert!(token.http_only && !token.subdomains && !token.secure);
    }

    #[test]
    fn what_is_not_an_export_is_refused_without_repeating_it() {
        for bad in ["", "   ", "hello there", "{\"a\": 1}", "[", "[]", "# only a comment", "sid=s3cr3t-value-0001"] {
            assert!(parse_export(bad).is_err(), "{bad:?}");
        }
        assert!(!parse_export("sid=s3cr3t-value-0001").unwrap_err().contains("s3cr3t"));
        assert!(!parse_export(r#"[{"domain": "example.com", "name": "sid", "value": "s3cr3t value"}]"#).unwrap_err().contains("s3cr3t"));
        assert!(parse_export(&"x".repeat(MAX_EXPORT_BYTES + 1)).unwrap_err().contains("too large"));
        // A value with a control character or a separator is not stored.
        for value in ["a;b", "a b", "a\u{7f}", "caf\u{e9}"] {
            let text = serde_json::json!([{"domain": "example.com", "name": "n", "value": value}]).to_string();
            assert!(parse_export(&text).is_err(), "{value:?}");
        }
        let many = serde_json::Value::Array(vec![serde_json::json!({"domain": "example.com", "name": "n", "value": "v"}); MAX_COOKIES + 5]).to_string();
        let (cookies, unreadable) = parse_export(&many).unwrap();
        assert_eq!((cookies.len(), unreadable), (MAX_COOKIES, 5));
    }

    #[test]
    fn only_the_sites_own_cookies_belong_to_it() {
        // The page is on www.example.com.
        for domain in ["www.example.com", "example.com", "accounts.example.com"] {
            assert!(belongs_to(domain, "www.example.com"), "{domain}");
        }
        // The page is on a subdomain: its parent's cookies reach it too.
        assert!(belongs_to("example.com", "app.example.com"));
        assert!(belongs_to("deep.app.example.com", "app.example.com"));
        for domain in ["other.test", "notexample.com", "example.com.evil.test", "com", "evilexample.com"] {
            assert!(!belongs_to(domain, "www.example.com"), "{domain}");
            assert!(!belongs_to(domain, "app.example.com"), "{domain}");
        }
        assert!(!belongs_to("sibling.example.com", "app.example.com"));
    }

    #[test]
    fn a_cookie_is_stored_with_its_attributes() {
        let (cookies, _) = parse_export(JSON).unwrap();
        let sid = cookies[0].to_cookie();
        // What the webview reads: the dot that makes it cover subdomains.
        assert_eq!((sid.name(), sid.value(), sid.domain(), sid.path()), ("sid", "abc123", Some(".example.com"), Some("/")));
        assert_eq!((sid.secure(), sid.http_only(), sid.same_site()), (Some(true), Some(true), Some(SameSite::Lax)));
        assert_eq!(sid.expires_datetime().map(|at| at.unix_timestamp()), Some(1893456000));
        let theme = cookies[1].to_cookie();
        assert_eq!(theme.domain(), Some("app.example.com"));
        assert!(theme.expires_datetime().is_none());
    }
}
