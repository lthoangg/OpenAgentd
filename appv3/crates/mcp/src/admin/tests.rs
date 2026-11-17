use super::*;

fn entry(v: Value) -> ServerConfig {
    parse_entry("s", &v).unwrap()
}

#[test]
fn the_agent_view_masks_every_secret_but_references() {
    let v = agent_view(&entry(json!({"command": "npx", "args": ["-y", "srv"], "env": {"TOKEN": "ghp_live", "REF": "${GITHUB_TOKEN}"}})));
    assert_eq!(v["env"], json!({"TOKEN": MASK, "REF": "${GITHUB_TOKEN}"}));
    assert_eq!(v["args"], json!(["-y", "srv"]));
    let v = agent_view(&entry(json!({"command": "npx", "env": {"TOKEN": "${S_MCP_ENV_TOKEN}"}})));
    assert_eq!(v["env"], json!({"TOKEN": MASK}), "a value OpenAgentd stored shows masked, like the value itself");
    let v = agent_view(&entry(json!({"url": "https://x/mcp", "headers": {"Authorization": "Bearer abc"}, "oauth": {"client_id": "id", "client_secret": "sec"}})));
    assert_eq!(v["headers"], json!({"Authorization": MASK}));
    assert_eq!(v["oauth"], json!({"client_id": MASK, "client_secret": MASK}));
    assert!(!v.to_string().contains("abc") && !v.to_string().contains("sec\""), "{v}");
}

#[test]
fn masked_values_keep_what_is_stored() {
    let old = entry(json!({"command": "a", "env": {"TOKEN": "t1", "MODE": "x"}}));
    let new = entry(json!({"command": "b", "env": {"TOKEN": MASK, "MODE": "y"}}));
    assert_eq!(merge_masked(new, Some(&old)), entry(json!({"command": "b", "env": {"TOKEN": "t1", "MODE": "y"}})));
    let old = entry(json!({"url": "https://x", "headers": {"A": "s"}}));
    let new = entry(json!({"url": "https://y", "headers": {"A": MASK}}));
    assert_eq!(merge_masked(new, Some(&old)), entry(json!({"url": "https://y", "headers": {"A": "s"}})));
}

#[test]
fn an_entry_is_validated_like_mcp_json() {
    assert!(parse_entry("1bad", &json!({"command": "x"})).unwrap_err().starts_with("Invalid MCP server name"));
    assert!(parse_entry("ok", &json!({"command": ""})).unwrap_err().contains("at least 1 character"));
    assert!(parse_entry("ok", &json!({"command": "x", "nope": 1})).unwrap_err().contains("Extra inputs are not permitted"));
    assert!(parse_entry("ok", &json!("npx")).unwrap_err().starts_with("config must be a JSON object"));
    assert_eq!(parse_entry("ok", &json!({"url": "https://x"})).unwrap().transport(), "http");
}

fn plugin_server(name: &str, plugin: &str, command: &str) -> crate::plugin::Wanted {
    let config = ServerConfig::Stdio { command: command.into(), args: vec![], env: IndexMap::new(), enabled: false, timeout: None, cwd: Some("/plugins/p".into()) };
    crate::plugin::Wanted { name: name.into(), plugin: plugin.into(), config }
}

/// The user's part of `servers` reads exactly as it did before plugins
/// had servers; theirs come after, labelled, and read-only.
#[tokio::test]
async fn the_server_list_shows_the_plugins_servers_after_the_users_and_says_whose_they_are() {
    let m = McpManager::default();
    let mine = cfgmod::parse_config(&json!({"servers": {"mine": {"command": "x", "enabled": false, "env": {"TOKEN": "t"}}}})).unwrap();
    m.spawn_runner("mine", &mine.servers["mine"]);

    assert_eq!(servers_text_for(&m, Ok(cfgmod::McpConfig::default())), "No MCP servers are configured. Add one with action='save'.");
    assert_eq!(servers_text_for(&m, Err("bad".into())), "mcp.json is invalid, so no server runs from it: bad");
    let plain = servers_text_for(&m, Ok(mine.clone()));
    assert_eq!(
        plain,
        "MCP servers (secrets show as ********; send them back unchanged to keep them):\n- mine (stdio, disabled)\n  config: {\"transport\":\"stdio\",\"command\":\"x\",\"args\":[],\"env\":{\"TOKEN\":\"********\"},\"enabled\":false}"
    );

    m.apply_plugin_servers(vec![plugin_server("changelog-tools/github", "changelog-tools", "npx")]).await;
    let text = servers_text_for(&m, Ok(mine));
    let (head, plugins) = text.split_at(plain.len());
    assert_eq!(head, plain, "the user's servers read as before");
    assert!(plugins.starts_with("\nServers from plugins (read-only"), "{plugins}");
    assert!(plugins.contains("\n- changelog-tools/github (stdio, disabled, from plugin changelog-tools)\n  config: {"), "{plugins}");
    assert!(plugins.contains(r#""cwd":"/plugins/p""#), "{plugins}");

    // Nothing of the user's own: say so, and still list the plugins'.
    let only = servers_text_for(&m, Ok(cfgmod::McpConfig::default()));
    assert!(only.starts_with("No MCP servers are configured in mcp.json. Add one with action='save'.\nServers from plugins"), "{only}");
    let broken = servers_text_for(&m, Err("bad".into()));
    assert!(broken.starts_with("mcp.json is invalid, so no server runs from it: bad\nServers from plugins"), "{broken}");
}

/// A confirmed change never reaches a plugin's server, whatever a card
/// says: it is not the user's `mcp.json` entry to change.
#[tokio::test]
async fn a_confirmed_change_does_not_apply_to_a_plugins_server() {
    let m = McpManager::default();
    m.apply_plugin_servers(vec![plugin_server("changelog-tools/github", "changelog-tools", "npx")]).await;
    for ty in [SAVE_CHANGE, REMOVE_CHANGE] {
        let e = apply(&m, &json!({"type": ty, "name": "changelog-tools/github", "config": {"command": "x"}, "before": "absent"})).await.unwrap_err();
        assert_eq!(e, "changelog-tools/github comes from plugin changelog-tools; manage it in Settings → Plugins");
    }
    assert!(m.get_status("changelog-tools/github").is_some());
}

#[test]
fn the_agent_sees_the_gallery_connectors_not_added_yet_and_how_to_add_each() {
    let hint = |id: &str, url: &str, auth| GalleryHint { id: id.into(), name: id.to_uppercase(), url: url.into(), auth };
    let hints = [
        hint("docs", "https://docs.example/mcp", GalleryAuth::None),
        hint("notes", "https://notes.example/mcp", GalleryAuth::OAuth),
        hint("gh", "https://gh.example/mcp/", GalleryAuth::Key),
    ];
    let mut cfg = cfgmod::McpConfig::default();
    cfg.servers.insert("mine".into(), entry(json!({"url": "https://DOCS.example/mcp/"})));
    let text = gallery_text_from(&hints, Some(&cfg)).unwrap();
    assert!(!text.contains("(docs)"), "already added: {text}");
    assert!(
        text.contains(
            r#"- NOTES (notes) — signs in with the user's account: add it with action='save', server='notes', config={"url": "https://notes.example/mcp"}, then the user signs in"#
        ),
        "{text}"
    );
    assert!(text.contains("- GH (gh) — needs the user's key: the user turns it on in Settings → Connectors"), "{text}");
    assert_eq!(gallery_text_from(&hints[..1], Some(&cfg)), None, "nothing left to add");
}
