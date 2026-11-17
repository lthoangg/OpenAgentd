use super::*;

#[test]
fn roundtrip_and_errors() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("mcp.json");
    assert!(load_config_from(&p).unwrap().servers.is_empty());
    std::fs::write(&p, r#"{"servers":{"fs":{"command":"npx","args":["-y"]},"gh":{"transport":"http","url":"https://x","headers":{"A":"é"}}}}"#).unwrap();
    let c = load_config_from(&p).unwrap();
    assert_eq!(c.servers["fs"].transport(), "stdio");
    save_config_to(&c, &p).unwrap();
    let text = std::fs::read_to_string(&p).unwrap();
    assert!(text.contains("\"A\": \"\\u00e9\""), "{text}");
    assert!(text.starts_with("{\n  \"servers\": {\n    \"fs\": {\n      \"args\": [\n        \"-y\"\n      ],"), "{text}");
    assert_eq!(load_config_from(&p).unwrap(), c);
    std::fs::write(&p, r#"{"servers":{"1bad":{"command":"x"}}}"#).unwrap();
    assert!(load_config_from(&p).unwrap_err().starts_with("Invalid MCP server name '1bad'"));
    std::fs::write(&p, r#"{"servers":{"a":{"command":""}}}"#).unwrap();
    assert!(load_config_from(&p).unwrap_err().contains("String should have at least 1 character"));
}

#[test]
fn env_refs() {
    std::env::set_var("OAD_MCP_TEST_X", "v");
    assert_eq!(resolve_secret_refs("a ${OAD_MCP_TEST_X} $OAD_MCP_TEST_X $NOPE_OAD_Z"), "a v v $NOPE_OAD_Z");
}

/// `cwd` belongs to plugin servers: `mcp.json` neither takes it nor
/// shows it, so the file reads and writes exactly as before.
#[test]
fn mcp_json_has_no_working_directory() {
    let err = parse_config(&json!({"servers": {"a": {"command": "x", "cwd": "/tmp"}}})).unwrap_err();
    assert_eq!(err, "1 validation error for MCPConfig\nservers.a.StdioServerConfig.cwd\n  Extra inputs are not permitted");

    let plain = parse_config(&json!({"servers": {"a": {"command": "npx", "args": ["-y"], "env": {"K": "v"}, "timeout": 5}}})).unwrap();
    assert_eq!(plain.servers["a"].cwd(), None);
    let dumped = plain.servers["a"].dump();
    assert_eq!(dumped.to_string(), r#"{"transport":"stdio","command":"npx","args":["-y"],"env":{"K":"v"},"enabled":true,"timeout":5}"#);

    let mut plugin = plain.servers["a"].clone();
    if let ServerConfig::Stdio { cwd, .. } = &mut plugin {
        *cwd = Some("/plugins/p".into());
    }
    assert_eq!(plugin.cwd(), Some(Path::new("/plugins/p")));
    assert_ne!(plugin, plain.servers["a"], "the directory is part of what a plugin sync compares");
    assert_eq!(plugin.dump(), dumped, "never written to mcp.json, so the file always parses");
    assert_eq!(parse_config(&json!({"servers": {"a": plugin.dump()}})).unwrap().servers["a"], plain.servers["a"]);
}

/// The transport spellings other MCP clients' files use, and the legacy HTTP+SSE one.
#[test]
fn type_is_read_as_transport_and_sse_is_the_legacy_transport() {
    let kind = |v: Value| match parse_config(&json!({"servers": {"a": v}})).unwrap().servers["a"].clone() {
        ServerConfig::Http { kind, .. } => Some(kind),
        ServerConfig::Stdio { .. } => None,
    };
    assert_eq!(kind(json!({"url": "https://x"})), Some(HttpKind::Auto));
    assert_eq!(kind(json!({"type": "http", "url": "https://x"})), Some(HttpKind::Auto));
    assert_eq!(kind(json!({"type": "streamable-http", "url": "https://x"})), Some(HttpKind::Auto));
    assert_eq!(kind(json!({"transport": "sse", "url": "https://x"})), Some(HttpKind::Sse));
    assert_eq!(kind(json!({"type": "stdio", "command": "npx"})), None);

    let sse = parse_config(&json!({"servers": {"a": {"type": "sse", "url": "https://x"}}})).unwrap();
    assert_eq!(sse.servers["a"].transport(), "sse");
    assert_eq!(sse.servers["a"].dump()["transport"], "sse", "written back as transport");
    assert_eq!(parse_config(&json!({"servers": {"a": sse.servers["a"].dump()}})).unwrap(), sse);

    let clash = parse_config(&json!({"servers": {"a": {"type": "sse", "transport": "http", "url": "https://x"}}})).unwrap_err();
    assert!(clash.contains("servers.a.type"), "{clash}");
    let unknown = parse_config(&json!({"servers": {"a": {"type": "ws", "url": "wss://x"}}})).unwrap_err();
    assert!(unknown.contains("Input should be 'http', 'streamable-http' or 'sse'"), "{unknown}");
}

#[test]
fn http_servers_sign_in_unless_their_header_sets_the_credentials() {
    let server = |v: Value| parse_config(&json!({"servers": {"a": v}})).unwrap().servers["a"].clone();
    assert!(server(json!({"url": "https://x"})).signs_in_with_oauth());
    assert!(server(json!({"url": "https://x", "headers": {"X-Team": "t"}})).signs_in_with_oauth());
    assert!(!server(json!({"url": "https://x", "headers": {"authorization": "Bearer ${TOKEN}"}})).signs_in_with_oauth());
    assert!(server(json!({"url": "https://x", "headers": {"Authorization": "x"}, "oauth": {}})).signs_in_with_oauth(), "an oauth block wins");
    assert!(!server(json!({"command": "npx"})).signs_in_with_oauth());
}
