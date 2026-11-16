use super::*;

#[test]
fn cache_files_keep_the_names_v2_stored_and_flatten_a_plugins_servers() {
    assert_eq!(cache_file_name("docs"), "docs.json");
    assert_eq!(cache_file_name("my_server-2"), "my_server-2.json");
    assert_eq!(cache_file_name("changelog-tools/github"), "changelog-tools%2Fgithub.json");
    assert_eq!(cache_file_name("lint/git.hub"), "lint%2Fgit.hub.json");
    for hostile in ["../escape", "a/../../b", "a\\b", "/abs"] {
        let file = cache_file_name(hostile);
        assert!(!file.contains('/') && !file.contains('\\'), "{file}");
    }
    assert_ne!(cache_file_name("a/b"), cache_file_name("a_b"));
}

#[test]
fn url_helpers() {
    assert_eq!(norm_http("https://Ex.COM").as_deref(), Some("https://ex.com"));
    assert_eq!(norm_http("https://ex.com/").as_deref(), Some("https://ex.com/"));
    assert_eq!(norm_http("https://ex.com:443/a/").as_deref(), Some("https://ex.com/a/"));
    assert_eq!(norm_http("HTTPS://ex.com:8443/x?y=1").as_deref(), Some("https://ex.com:8443/x?y=1"));
    assert_eq!(norm_http("https://ex.com?y=1").as_deref(), Some("https://ex.com?y=1"));
    assert_eq!(norm_http("https://ex.com/a b").as_deref(), Some("https://ex.com/a%20b"));
    assert_eq!(norm_http("ftp://ex.com"), None);
    assert_eq!(resource_url_from_server_url("HTTP://Ex.com/MCP#frag"), "http://ex.com/MCP");
    assert!(check_resource_allowed("https://a.com/mcp", "https://a.com"));
    assert!(check_resource_allowed("https://a.com/mcp", "https://a.com/mcp/"));
    assert!(!check_resource_allowed("https://a.com/api123", "https://a.com/api"));
    assert!(root_slash_variant("https://a.com/", "https://a.com"));
    assert!(!root_slash_variant("https://a.com/x", "https://a.com"));
    assert!(issuers_match("https://a.com", "https://a.com/"));
    assert!(!issuers_match("https://a.com/x", "https://a.com/x/"));
    assert_eq!(origin_issuer("https://A.com:443/mcp"), "https://a.com");
    assert_eq!(www_auth_field(Some(r#"Bearer error="insufficient_scope", scope="a b", resource_metadata=https://x/y"#), "scope").as_deref(), Some("a b"));
    assert_eq!(www_auth_field(Some(r#"Bearer resource_metadata=https://x/y, x=1"#), "resource_metadata").as_deref(), Some("https://x/y"));
}

#[test]
fn scopes() {
    let asm = AsMeta {
        issuer: "https://a".into(),
        authorization_endpoint: "https://a/auth".into(),
        token_endpoint: "https://a/tok".into(),
        registration_endpoint: None,
        scopes_supported: Some(vec!["read".into(), "offline_access".into()]),
        authorization_response_iss_parameter_supported: None,
    };
    assert_eq!(select_scopes(Some("x".into()), None, Some(&asm), &GRANT_TYPES).as_deref(), Some("x offline_access"));
    assert_eq!(select_scopes(None, None, Some(&asm), &GRANT_TYPES).as_deref(), Some("read offline_access"));
    assert_eq!(select_scopes(None, None, None, &GRANT_TYPES), None);
    assert_eq!(union_scopes(Some("a b".into()), Some("b c".into())).as_deref(), Some("a b c"));
}

#[test]
fn models() {
    let t = Token::validate(&json!({"access_token": "a", "token_type": "bearer", "expires_in": "3600"})).unwrap();
    assert_eq!(t.dump().to_string(), r#"{"access_token":"a","token_type":"Bearer","expires_in":3600,"scope":null,"refresh_token":null}"#);
    assert!(Token::validate(&json!({"access_token": "a", "token_type": "mac"})).is_err());
    let ci = validate_client_info(
        &json!({"client_id": "x", "redirect_uris": ["http://localhost:5/callback"], "client_uri": "https://Ex.com", "scope": "a b", "client_id_issued_at": "12", "logo_uri": ""}),
    )
    .unwrap();
    assert_eq!(
        Value::Object(ci).to_string(),
        r#"{"response_types":["code"],"scope":"a b","client_name":null,"client_uri":"https://ex.com","logo_uri":null,"contacts":null,"tos_uri":null,"policy_uri":null,"jwks_uri":null,"jwks":null,"software_id":null,"software_version":null,"redirect_uris":["http://localhost:5/callback"],"token_endpoint_auth_method":null,"grant_types":["authorization_code","refresh_token"],"application_type":null,"client_id":"x","client_secret":null,"client_id_issued_at":12,"client_secret_expires_at":null,"issuer":null}"#
    );
}
