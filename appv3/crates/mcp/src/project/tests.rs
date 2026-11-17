use super::*;
use serde_json::json;

fn ws() -> PathBuf {
    PathBuf::from("/repo/app")
}

#[test]
fn servers_and_mcp_servers_both_load_and_stdio_runs_in_the_workspace() {
    let a = parse_project_config(&json!({"servers": {"db": {"command": "./db-mcp"}}}), &ws()).unwrap();
    let b = parse_project_config(&json!({"$schema": "x", "mcpServers": {"db": {"command": "./db-mcp"}}}), &ws()).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.servers["db"].cwd(), Some(ws().as_path()));
    let http = parse_project_config(&json!({"mcpServers": {"docs": {"type": "http", "url": "https://docs.example.com/mcp"}}}), &ws()).unwrap();
    assert_eq!(http.servers["docs"].transport(), "http");
}

#[test]
fn an_invalid_project_file_says_what_is_wrong() {
    assert!(parse_project_config(&json!({"servers": {}, "mcpServers": {}}), &ws()).unwrap_err().contains("not both"));
    assert!(parse_project_config(&json!({"servers": {"db": {"command": ""}}}), &ws()).unwrap_err().contains("at least 1 character"));
    assert!(parse_project_config(&json!({"servers": {"1db": {"command": "x"}}}), &ws()).unwrap_err().starts_with("Invalid MCP server name"));
    assert!(parse_project_config(&json!({"servers": {"db": {"command": "x", "cwd": "/"}}}), &ws()).unwrap_err().contains("cwd"), "a project cannot pick another directory");
}

#[test]
fn a_missing_file_is_no_servers_and_a_broken_one_names_the_file() {
    let d = tempfile::tempdir().unwrap();
    assert!(load_project_config(d.path()).unwrap().servers.is_empty());
    std::fs::create_dir_all(d.path().join(".agents")).unwrap();
    std::fs::write(project_file(d.path()), "{ not json").unwrap();
    let err = load_project_config(d.path()).unwrap_err();
    assert!(err.contains(".agents/mcp.json") || err.contains(".agents\\mcp.json"), "{err}");
}

#[test]
fn keys_differ_by_workspace_and_never_look_like_a_users_or_plugins_name() {
    let a = runner_key("/repo/a", "db");
    let b = runner_key("/repo/b", "db");
    assert_ne!(a, b);
    assert!(a.starts_with("db@") && a.len() == "db@".len() + 10, "{a}");
    assert!(cfgmod::validate_server_name(&a).is_err() && !a.contains('/'));
    assert_eq!(a, runner_key("/repo/a", "db"), "stable");
}

#[test]
fn an_approval_holds_for_the_exact_entry_only() {
    let d = tempfile::tempdir().unwrap();
    let store = Approvals::at(d.path().join("approvals.json"));
    let cfg = parse_project_config(&json!({"servers": {"db": {"command": "./db-mcp", "args": ["--ro"]}}}), &ws()).unwrap();
    let db = &cfg.servers["db"];
    let ws = "/repo/app";
    assert!(!store.approved(ws, "db", db));
    store.approve(ws, "db", db).unwrap();
    assert!(store.approved(ws, "db", db));
    assert!(!store.approved("/repo/other", "db", db), "per workspace");
    let changed = parse_project_config(&json!({"servers": {"db": {"command": "./db-mcp", "args": ["--rw"]}}}), Path::new(ws)).unwrap();
    assert!(!store.approved(ws, "db", &changed.servers["db"]), "a changed entry needs approval again");
    store.revoke(ws, "db").unwrap();
    assert!(!store.approved(ws, "db", db));
    assert_eq!(std::fs::read_to_string(d.path().join("approvals.json")).unwrap().trim(), "{}");
}

#[test]
fn the_card_names_the_variables_a_server_reads_never_their_values() {
    let cfg = parse_project_config(
        &json!({"servers": {
            "a": {"command": "x", "env": {"T": "${GITHUB_TOKEN}", "U": "pre-$USER-${GITHUB_TOKEN}", "P": "plain"}},
            "b": {"url": "https://h/${TENANT}/mcp", "headers": {"Authorization": "Bearer ${API_KEY}"}}
        }}),
        &ws(),
    )
    .unwrap();
    assert_eq!(referenced_variables(&cfg.servers["a"]), ["GITHUB_TOKEN", "USER"]);
    assert_eq!(referenced_variables(&cfg.servers["b"]), ["API_KEY"], "a URL is not filled in");
}
