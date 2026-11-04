//! The URL and header rules of remote MCP servers, one rule at a time.

use serde_json::{json, Map, Value};

use crate::remote::{check_headers, check_url};

fn accepted(url: &str) -> bool {
    check_url(url).is_ok()
}

fn rejection(url: &str) -> String {
    check_url(url).expect_err("the URL must be rejected")
}

fn headers(value: Value) -> Result<std::collections::BTreeMap<String, String>, String> {
    let Value::Object(map) = value else { panic!("headers must be an object") };
    check_headers(&map, &|text| text.to_string())
}

#[test]
fn https_url_is_accepted() {
    assert!(accepted("https://example.com/mcp"));
    assert!(accepted("https://example.com"));
    assert!(accepted("https://example.com:8443/mcp?x=1&y=2"));
    assert!(accepted("https://sub.example.co.uk/a/b/c"));
}

#[test]
fn scheme_case_does_not_matter() {
    assert!(accepted("HTTPS://example.com/mcp"));
    assert!(accepted("Http://LOCALHOST/mcp"));
}

#[test]
fn plain_http_is_accepted_for_localhost() {
    assert!(accepted("http://localhost/mcp"));
    assert!(accepted("http://localhost:3000/mcp"));
    assert!(accepted("http://LocalHost:3000/mcp"));
}

#[test]
fn plain_http_is_accepted_for_the_whole_ipv4_loopback_range() {
    assert!(accepted("http://127.0.0.1/"));
    assert!(accepted("http://127.255.255.254:9/"));
}

#[test]
fn plain_http_is_accepted_for_the_ipv6_loopback_address() {
    assert!(accepted("http://[::1]/mcp"));
    assert!(accepted("http://[::1]:8080/mcp"));
}

#[test]
fn plain_http_is_rejected_for_other_hosts() {
    for url in [
        "http://example.com/mcp",
        "http://10.0.0.1/mcp",
        "http://192.168.1.5:8080/",
        "http://[::2]/",
        "http://0.0.0.0/",
        "http://localhost.example.com/",
        "http://127.0.0.1.example.com/",
        "http://notlocalhost/",
    ] {
        assert!(rejection(url).contains("plain http is only allowed"), "{url}");
    }
}

#[test]
fn https_is_accepted_for_any_host() {
    assert!(accepted("https://10.0.0.1/mcp"));
    assert!(accepted("https://[2001:db8::1]/mcp"));
}

#[test]
fn user_information_is_rejected() {
    assert!(rejection("https://user@example.com/").contains("user information"));
    assert!(rejection("https://user:pass@example.com/").contains("user information"));
    assert!(rejection("https://:pass@example.com/").contains("user information"));
    assert!(rejection("https://@example.com/").contains("user information"));
}

#[test]
fn an_at_sign_after_the_host_is_not_user_information() {
    assert!(accepted("https://example.com/users/@me"));
    assert!(accepted("https://example.com/?email=a@b.c"));
}

#[test]
fn fragment_is_rejected_even_when_empty() {
    assert!(rejection("https://example.com/mcp#frag").contains("fragment"));
    assert!(rejection("https://example.com/mcp#").contains("fragment"));
    assert!(rejection("https://example.com#frag").contains("fragment"));
}

#[test]
fn other_schemes_are_rejected() {
    for url in ["ftp://example.com/", "ws://example.com/", "wss://example.com/", "file:///etc/passwd", "javascript://example.com"] {
        assert!(rejection(url).contains("is not http or https"), "{url}");
    }
}

#[test]
fn url_without_a_scheme_separator_is_not_absolute() {
    for url in ["example.com", "/mcp", "//example.com/mcp", "https:example.com", "mailto:a@b.c", ""] {
        assert!(rejection(url).contains("not an absolute http or https URL"), "{url}");
    }
}

#[test]
fn url_without_a_host_is_rejected() {
    for url in ["https:///mcp", "https://", "https://:8080/mcp", "http://?x=1"] {
        assert!(rejection(url).contains("no host"), "{url}");
    }
}

#[test]
fn whitespace_control_characters_and_backslashes_are_rejected() {
    for url in ["https://exa mple.com/", "https://example.com/a b", "https://example.com/\n", "https://example.com\\mcp", "https://example.com/\t", "https://ex\u{0}ample.com/"] {
        assert!(rejection(url).contains("whitespace"), "{url:?}");
    }
}

#[test]
fn host_with_characters_that_are_not_allowed_is_rejected() {
    for url in ["https://exa%6Dple.com/", "https://exam!ple.com/", "https://münchen.de/", "https://a,b.com/"] {
        assert!(rejection(url).contains("characters that are not allowed"), "{url}");
    }
}

#[test]
fn numeric_host_that_is_not_a_dotted_quad_is_rejected() {
    for url in ["https://127.1/", "https://2130706433/", "https://1.2.3/", "https://1.2.3.256/", "http://127.1/"] {
        assert!(rejection(url).contains("not a valid IPv4 address"), "{url}");
    }
}

#[test]
fn invalid_ipv6_host_is_rejected() {
    assert!(rejection("https://[::1/").contains("unterminated"));
    assert!(rejection("https://[not-an-address]/").contains("not a valid IPv6 address"));
    assert!(rejection("https://[::1]x/").contains("text after the IPv6 address"));
}

#[test]
fn ipv6_host_without_brackets_is_rejected() {
    assert!(check_url("https://::1/mcp").is_err());
}

#[test]
fn port_must_be_a_number_from_1_to_65535() {
    assert!(accepted("https://example.com:1/"));
    assert!(accepted("https://example.com:65535/"));
    for url in
        ["https://example.com:0/", "https://example.com:65536/", "https://example.com:abc/", "https://example.com:/", "https://example.com:-1/", "https://example.com:80:80/"]
    {
        assert!(check_url(url).is_err(), "{url}");
    }
}

#[test]
fn header_names_must_be_tokens() {
    assert!(headers(json!({ "X-Api-Key": "v", "Accept": "text/plain", "x_custom.v1~": "v" })).is_ok());
    for name in ["", "Has Space", "Colon:Here", "Slash/Here", "Quote\"Here", "Paren(Here"] {
        let error = headers(json!({ name: "v" })).unwrap_err();
        assert!(error.contains("an invalid name in 'headers'"), "{name:?}: {error}");
    }
}

#[test]
fn header_names_differing_only_in_case_are_duplicates() {
    let error = headers(json!({ "Authorization": "a", "AUTHORIZATION": "b" })).unwrap_err();
    assert!(error.contains("duplicate names in 'headers' ('AUTHORIZATION' repeats 'Authorization'"), "{error}");
}

#[test]
fn header_values_may_hold_tabs_and_non_ascii_text() {
    let parsed = headers(json!({ "X-A": "a\tb", "X-B": "café" })).unwrap();
    assert_eq!(parsed["X-A"], "a\tb");
    assert_eq!(parsed["X-B"], "café");
}

#[test]
fn header_values_may_not_hold_control_characters() {
    for value in ["a\nb", "a\rb", "a\u{0}b", "a\u{7f}b"] {
        let error = headers(json!({ "X-A": value })).unwrap_err();
        assert!(error.contains("an invalid value in 'headers' for 'X-A'"), "{value:?}: {error}");
    }
}

#[test]
fn header_values_are_checked_after_expansion() {
    let Value::Object(map) = json!({ "X-A": "token" }) else { unreachable!() };
    let error = check_headers(&map, &|_| "line\nbreak".to_string()).unwrap_err();
    assert!(error.contains("an invalid value in 'headers' for 'X-A'"), "{error}");
}

#[test]
fn no_headers_is_fine() {
    assert!(check_headers(&Map::new(), &|text| text.to_string()).unwrap().is_empty());
}

#[test]
fn odd_urls_are_rejected_without_panicking() {
    for url in [
        "https://[",
        "https://[]",
        "https://[]:",
        "https://:",
        "http://@",
        "://",
        "https://😀/",
        "https://é",
        "https://[é]/",
        "http://[::1]:é/",
        "https://a:😀/",
        "https://\u{85}",
        "http:////",
        "https://[::1]]/",
    ] {
        assert!(check_url(url).is_err(), "{url:?}");
    }
}
