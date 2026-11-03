//! Validation of remote MCP server settings: the URL and the HTTP headers.
//!
//! A small parser instead of the `url` crate: it only has to decide whether
//! a string is an acceptable endpoint, and it errs on the strict side
//! (no backslashes, no whitespace, no numeric host shorthands such as
//! `127.1`) so there is no room for a parser to disagree with another.

use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};

use serde_json::{Map, Value};

use crate::util::shorten;

enum Host {
    Name(String),
    V4(Ipv4Addr),
    V6(Ipv6Addr),
}

impl Host {
    /// `localhost`, `127.0.0.0/8`, or `::1`.
    fn is_loopback(&self) -> bool {
        match self {
            Host::Name(name) => name == "localhost",
            Host::V4(addr) => addr.is_loopback(),
            Host::V6(addr) => addr.is_loopback(),
        }
    }
}

/// An absolute `http(s)` URL without user information or a fragment; plain
/// `http` only for a loopback host. The error is a phrase for
/// `has an invalid 'url' (<error>)`.
pub(crate) fn check_url(url: &str) -> Result<(), String> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err("it contains whitespace, a control character or a backslash".to_string());
    }
    let (scheme, rest) = url.split_once("://").ok_or("it is not an absolute http or https URL")?;
    let secure = if scheme.eq_ignore_ascii_case("https") {
        true
    } else if scheme.eq_ignore_ascii_case("http") {
        false
    } else {
        return Err(format!("the scheme '{}' is not http or https", shorten(scheme, 20)));
    };
    if rest.contains('#') {
        return Err("it contains a fragment".to_string());
    }
    let authority = &rest[..rest.find(['/', '?']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return Err("it contains user information".to_string());
    }
    let host = parse_authority(authority)?;
    if !secure && !host.is_loopback() {
        return Err("plain http is only allowed for localhost and loopback addresses; use https".to_string());
    }
    Ok(())
}

/// The host of `host[:port]` (an IPv6 host is in brackets); checks the port.
fn parse_authority(authority: &str) -> Result<Host, String> {
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let (address, after) = inner.split_once(']').ok_or("the host has an unterminated '['")?;
        let address = address.parse::<Ipv6Addr>().map_err(|_| "the host is not a valid IPv6 address".to_string())?;
        let port = match after {
            "" => None,
            after => Some(after.strip_prefix(':').ok_or("there is text after the IPv6 address")?),
        };
        (Host::V6(address), port)
    } else {
        let (name, port) = match authority.rsplit_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (authority, None),
        };
        (parse_host_name(name)?, port)
    };
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) || !matches!(port.parse::<u16>(), Ok(1..)) {
            return Err(format!("the port '{}' is not valid", shorten(port, 10)));
        }
    }
    Ok(host)
}

/// A DNS name or an IPv4 address in dotted-decimal form.
fn parse_host_name(name: &str) -> Result<Host, String> {
    if name.is_empty() {
        return Err("it has no host".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
        return Err("the host has characters that are not allowed".to_string());
    }
    if name.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return name.parse::<Ipv4Addr>().map(Host::V4).map_err(|_| "the host is not a valid IPv4 address".to_string());
    }
    Ok(Host::Name(name.to_ascii_lowercase()))
}

/// Validates `headers`: names are HTTP tokens, none repeats under another
/// casing, and values (after `expand`) are legal field values. Returns them
/// with names as written. The error completes `has …`.
pub(crate) fn check_headers(headers: &Map<String, Value>, expand: &dyn Fn(&str) -> String) -> Result<BTreeMap<String, String>, String> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    let mut out = BTreeMap::new();
    for (name, value) in headers {
        if !is_token(name) {
            return Err(format!("an invalid name in 'headers' ('{}')", shorten(name, 40)));
        }
        if let Some(first) = seen.insert(name.to_ascii_lowercase(), name) {
            return Err(format!("duplicate names in 'headers' ('{}' repeats '{}'; header names are case-insensitive)", shorten(name, 40), shorten(first, 40)));
        }
        let Some(value) = value.as_str() else {
            return Err(format!("a value in 'headers' that is not a string ('{}')", shorten(name, 40)));
        };
        let value = expand(value);
        if !value.chars().all(|c| c == '\t' || !c.is_control()) {
            return Err(format!("an invalid value in 'headers' for '{}' (control characters)", shorten(name, 40)));
        }
        out.insert(name.clone(), value);
    }
    Ok(out)
}

/// An HTTP token (RFC 9110): the legal characters of a header name.
fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'))
}
