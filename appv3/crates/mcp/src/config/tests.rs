use super::*;

fn cfg(v: Value) -> McpConfig {
    parse_config(&v).unwrap()
}

fn stored(creds: &Path) -> IndexMap<String, String> {
    appv3_core::credentials::load_from(creds).unwrap().secrets.clone()
}

#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn saving_moves_literal_secrets_to_the_credential_store() {
    let d = tempfile::tempdir().unwrap();
    let (p, creds) = (d.path().join("mcp.json"), d.path().join("credentials.yaml"));
    let c = cfg(json!({"servers": {
        "discord": {"command": "discord-mcp", "env": {"DISCORD_TOKEN": "tok-1", "REF": "${GITHUB_TOKEN}", "MIXED": "x-$HOME", "EMPTY": ""}},
        "web": {"url": "https://x/mcp", "headers": {"Authorization": "Bearer hdr-1"}, "oauth": {"client_id": "cid-1", "client_secret": "sec-1"}}
    }}));
    save_config_at(&c, &p, &creds).unwrap();

    let text = std::fs::read_to_string(&p).unwrap();
    for literal in ["tok-1", "hdr-1", "cid-1", "sec-1"] {
        assert!(!text.contains(literal), "{literal} left in mcp.json: {text}");
    }
    let back = load_config_from(&p).unwrap();
    let ServerConfig::Stdio { env, .. } = &back.servers["discord"] else { panic!() };
    assert_eq!(env["DISCORD_TOKEN"], "${DISCORD_MCP_ENV_DISCORD_TOKEN}");
    assert_eq!((env["REF"].as_str(), env["MIXED"].as_str(), env["EMPTY"].as_str()), ("${GITHUB_TOKEN}", "x-$HOME", ""), "references and empty values stay as written");
    let ServerConfig::Http { headers, oauth, .. } = &back.servers["web"] else { panic!() };
    assert_eq!(headers["Authorization"], "${WEB_MCP_HEADER_AUTHORIZATION}");
    let o = oauth.as_ref().unwrap();
    assert_eq!((o.client_id.as_deref(), o.client_secret.as_deref()), (Some("${WEB_MCP_CLIENT_ID}"), Some("${WEB_MCP_CLIENT_SECRET}")));

    let s = stored(&creds);
    assert_eq!(s["DISCORD_MCP_ENV_DISCORD_TOKEN"], "tok-1");
    assert_eq!(s["WEB_MCP_HEADER_AUTHORIZATION"], "Bearer hdr-1");
    assert_eq!((s["WEB_MCP_CLIENT_ID"].as_str(), s["WEB_MCP_CLIENT_SECRET"].as_str()), ("cid-1", "sec-1"));
    #[cfg(unix)]
    assert_eq!((mode(&p), mode(&creds)), (0o600, 0o600));
}

#[test]
fn a_removed_key_or_server_forgets_only_its_own_secret() {
    let d = tempfile::tempdir().unwrap();
    let (p, creds) = (d.path().join("mcp.json"), d.path().join("credentials.yaml"));
    appv3_core::credentials::update_at(&creds, |f| f.secrets.insert("GITHUB_TOKEN".into(), "mine".into())).unwrap();
    save_config_at(&cfg(json!({"servers": {"s": {"command": "x", "env": {"A": "a-1", "B": "b-1", "G": "${GITHUB_TOKEN}"}}}})), &p, &creds).unwrap();
    assert!(stored(&creds).contains_key("S_MCP_ENV_B"));

    let mut c = load_config_from(&p).unwrap();
    if let Some(ServerConfig::Stdio { env, .. }) = c.servers.get_mut("s") {
        env.shift_remove("B");
    }
    save_config_at(&c, &p, &creds).unwrap();
    let s = stored(&creds);
    assert!(!s.contains_key("S_MCP_ENV_B") && s["S_MCP_ENV_A"] == "a-1", "{:?}", s.keys());

    save_config_at(&McpConfig::default(), &p, &creds).unwrap();
    let s = stored(&creds);
    assert!(!s.contains_key("S_MCP_ENV_A"), "{:?}", s.keys());
    assert_eq!(s["GITHUB_TOKEN"], "mine", "a secret the user named is never removed");
}

#[test]
fn keys_that_normalize_alike_get_their_own_secret() {
    let (out, store, moved) = take_literal_secrets(&cfg(json!({"servers": {"s": {"command": "x", "env": {"a-b": "1", "A_B": "2"}}}})));
    assert_eq!(store, vec![("S_MCP_ENV_A_B".to_string(), "1".to_string()), ("S_MCP_ENV_A_B_2".to_string(), "2".to_string())]);
    assert_eq!(moved, ["s.a-b", "s.A_B"]);
    let ServerConfig::Stdio { env, .. } = &out.servers["s"] else { panic!() };
    assert_eq!(env["A_B"], "${S_MCP_ENV_A_B_2}");
}

#[test]
fn migration_moves_literals_tightens_the_file_and_skips_a_bad_one() {
    let d = tempfile::tempdir().unwrap();
    let (p, creds) = (d.path().join("mcp.json"), d.path().join("credentials.yaml"));
    assert_eq!(migrate_literal_secrets_at(&p, &creds).unwrap(), Vec::<String>::new(), "no file, nothing to do");

    std::fs::write(&p, r#"{"servers":{"discord":{"command":"discord-mcp","env":{"DISCORD_TOKEN":"tok-1","REF":"${GITHUB_TOKEN}"}}}}"#).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(migrate_literal_secrets_at(&p, &creds).unwrap(), ["discord.DISCORD_TOKEN"]);
    assert!(!std::fs::read_to_string(&p).unwrap().contains("tok-1"));
    assert_eq!(stored(&creds)["DISCORD_MCP_ENV_DISCORD_TOKEN"], "tok-1");
    #[cfg(unix)]
    assert_eq!(mode(&p), 0o600);

    let clean = std::fs::read_to_string(&p).unwrap();
    assert!(migrate_literal_secrets_at(&p, &creds).unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(&p).unwrap(), clean, "a clean file is not rewritten");

    std::fs::write(&p, r#"{"servers":{"a":{"command":"x","env":{"T":"lit"}}"#).unwrap();
    assert!(migrate_literal_secrets_at(&p, &creds).is_err());
    assert!(std::fs::read_to_string(&p).unwrap().contains("lit"), "a file that does not parse is left as it is");
}

#[test]
fn stored_secret_references_are_recognised() {
    assert!(is_stored_secret_ref("${DISCORD_MCP_ENV_DISCORD_TOKEN}"));
    assert!(is_stored_secret_ref("${GH_MCP_API_KEY}") && is_stored_secret_ref("${X_MCP_CLIENT_SECRET}"));
    assert!(!is_stored_secret_ref("${GITHUB_TOKEN}"));
    assert!(!is_stored_secret_ref("Bearer ${GH_MCP_API_KEY}"), "only a whole reference");
    assert_eq!(secret_name("my-server", "ENV_api.key"), "MY_SERVER_MCP_ENV_API_KEY");
}

#[test]
fn logged_urls_drop_what_may_carry_a_key() {
    assert_eq!(url_for_log("https://u:p@mcp.example.com/mcp?api_key=k1#f"), "https://mcp.example.com/mcp");
    assert_eq!(url_for_log("not a url?k=1"), "not a url");
}

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
