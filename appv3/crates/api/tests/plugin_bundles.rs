//! Plugin folders run as kernel modules: their skills, MCP servers and
//! code tools appear without a server restart, a broken plugin leaves the
//! others running, and Settings → Plugins turns one off or reloads them.
//!
//! Settings, the kernel and the plugin registry are process-global, so this
//! file is its own test binary and its tests run one at a time, each on a
//! freshly emptied plugin folder.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use appv3_tools::{ToolContext, ToolOutput};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tower::ServiceExt;

struct Env {
    _root: tempfile::TempDir,
    plugins: PathBuf,
    app: Router,
}

async fn env() -> &'static Env {
    static ENV: tokio::sync::OnceCell<Env> = tokio::sync::OnceCell::const_new();
    ENV.get_or_init(|| async {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, r.join(d));
        }
        std::env::set_var("HOME", r.join("home"));
        std::env::set_var("OPENAGENTD_ENV", "production");
        std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
        std::env::set_var("OPENAGENTD_PLUGINS_DIRS", r.join("plugins"));
        for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_DATABASE_URL", "OPENAGENTD_FS_WATCH"] {
            std::env::remove_var(k);
        }
        std::fs::create_dir_all(r.join("plugins")).unwrap();
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        let s = appv3_core::settings();
        std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
        let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
        appv3_db::migrations::run_migrations(&pool).await.unwrap();
        let app = create_app(AppState { pool }, Policy::from_env());
        Env { plugins: r.join("plugins"), _root: root, app }
    })
    .await
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(Default::default)
}

impl Env {
    async fn call(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if body.is_some() {
            req = req.header("content-type", "application/json");
        }
        let mut req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty)).unwrap();
        let local: SocketAddr = "127.0.0.1:8000".parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = tokio::time::timeout(Duration::from_secs(20), body.collect()).await.expect("response body ended").unwrap().to_bytes();
        (parts.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Empties the plugin folder and reloads, so no plugin runs.
    async fn fresh(&self) {
        for e in std::fs::read_dir(&self.plugins).unwrap().flatten() {
            std::fs::remove_dir_all(e.path()).unwrap();
        }
        appv3_api::plugins::reload().await;
    }

    fn bundle(&self, list: &Value, name: &str) -> Value {
        list["bundles"].as_array().unwrap().iter().find(|b| b["name"] == name).cloned().unwrap_or_else(|| panic!("no bundle {name} in {list}"))
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/tests/fixtures").join(name)
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A plugin whose code adds `draft` (read-only, answers `<version> since <tag>`)
/// and `peek`, which fetches a host its permissions do not list.
fn notes_kit(root: &Path, version: &str) {
    write(&root.join("plugin.json"), r#"{"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "notes-kit", "version": "0.1.0"}"#);
    write(
        &root.join("dev.openagentd/plugin.ts"),
        &format!(
            r#"import {{ defineTool }} from "openagentd"
export default {{
  tools: [
    defineTool({{
      name: "draft",
      description: "Draft release notes",
      readOnly: true,
      input: {{ type: "object", properties: {{ since: {{ type: "string", description: "Tag to start from" }} }}, required: ["since"] }},
      run: ({{ since }}) => `{version} since ${{since}}`,
    }}),
    defineTool({{
      name: "peek",
      description: "Fetch a page",
      input: {{ type: "object", properties: {{}} }},
      async run() {{ await fetch("https://example.com/"); return "fetched" }},
    }}),
  ],
}}
"#
        ),
    );
}

fn ctx() -> ToolContext {
    ToolContext {
        session_id: None,
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(appv3_tools::DeniedPaths::new(&std::env::temp_dir(), None)),
        workspace: None,
        output: None,
        metadata: Default::default(),
        messages: None,
    }
}

/// Runs plugin tool `name` (`<plugin>/<tool>`) as the `mcp` tool's `call` does once its checks pass.
async fn run_tool(name: &str, args: Value) -> String {
    let tools = appv3_agent::plugins::extra_tools();
    let t = tools.iter().find(|t| format!("{}/{}", t.plugin, t.name) == name).unwrap_or_else(|| panic!("no plugin tool {name}"));
    match t.runner.run(&ctx(), args).await {
        Ok(ToolOutput::Text(s)) => s,
        Ok(other) => panic!("{other:?}"),
        Err(e) => format!("Error: {e}"),
    }
}

fn module_state(id: &str) -> Option<&'static str> {
    appv3_kernel::global().status().into_iter().find(|m| m.id == id).map(|m| m.state.as_str())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn standard_plugin_folders_load_skills_and_mcp_servers_and_a_broken_one_is_isolated() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    copy_dir(&fixture("changelog-tools"), &e.plugins.join("changelog-tools"));
    copy_dir(&fixture("review-kit"), &e.plugins.join("review-kit"));
    write(&e.plugins.join("broken/plugin.json"), "{not json");

    let (st, list) = e.call("POST", "/api/plugins/reload", None).await;
    assert_eq!(st, StatusCode::OK, "{list}");
    let names: Vec<&str> = list["bundles"].as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["broken", "changelog-tools", "review-kit"]);
    let broken = e.bundle(&list, "broken");
    assert_eq!(broken["state"], "failed");
    assert!(broken["errors"][0].as_str().unwrap().starts_with("plugin.json: is not valid JSON"), "{broken}");
    assert_eq!((module_state("plugin:changelog-tools"), module_state("plugin:review-kit")), (Some("running"), Some("running")));

    let tools = e.bundle(&list, "changelog-tools");
    assert_eq!((tools["state"].as_str(), tools["has_code"].as_bool()), (Some("running"), Some(true)), "{tools}");
    assert_eq!(tools["skills"][0]["name"], "changelog-tools/release-notes");
    let echo = &tools["mcp_servers"][0];
    assert_eq!((echo["name"].as_str(), echo["transport"].as_str()), (Some("changelog-tools/echo"), Some("stdio")), "{echo}");
    assert!(echo["command"].as_str().unwrap().ends_with("/changelog-tools/bin/echo-mcp"), "a ./ command runs from the plugin folder: {echo}");
    assert_eq!(tools["permissions"], json!({"net": ["api.github.com"], "listen": false, "fs": [], "subprocess": [], "env": ["GITHUB_TOKEN"]}));
    let review = e.bundle(&list, "review-kit");
    assert_eq!(review["permissions"], Value::Null, "{review}");
    assert_eq!(review["mcp_servers"][0], json!({"name": "review-kit/docs", "transport": "http", "command": null, "args": [], "url": "https://docs.example.com/mcp"}));

    let skills: Vec<String> = appv3_agent::skills::discover_skills(None).into_iter().map(|s| s.name).collect();
    assert!(skills.contains(&"changelog-tools/release-notes".to_string()) && skills.contains(&"review-kit/code-review".to_string()), "{skills:?}");
    let servers: Vec<(String, Option<String>)> = appv3_mcp::mcp_manager().list_status().into_iter().map(|s| (s.name, s.plugin)).collect();
    assert!(servers.contains(&("changelog-tools/echo".to_string(), Some("changelog-tools".to_string()))), "{servers:?}");
    assert!(servers.contains(&("review-kit/docs".to_string(), Some("review-kit".to_string()))), "{servers:?}");

    // Deleting a plugin folder takes away what it provided.
    std::fs::remove_dir_all(e.plugins.join("review-kit")).unwrap();
    appv3_api::plugins::reload().await;
    assert_eq!(module_state("plugin:review-kit"), None);
    assert!(appv3_mcp::mcp_manager().get_status("review-kit/docs").is_none());
    assert!(!appv3_agent::skills::discover_skills(None).iter().any(|s| s.name == "review-kit/code-review"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plugin_tools_run_in_their_sandbox_and_edited_code_runs_after_a_reload() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    notes_kit(&e.plugins.join("notes-kit"), "v1");
    let (_, list) = e.call("POST", "/api/plugins/reload", None).await;
    let kit = e.bundle(&list, "notes-kit");
    assert_eq!(kit["state"], "running", "{kit}");
    assert_eq!(
        kit["tools"],
        json!([{"name": "notes-kit/draft", "description": "Draft release notes", "read_only": true}, {"name": "notes-kit/peek", "description": "Fetch a page", "read_only": false}])
    );
    assert_eq!(run_tool("notes-kit/draft", json!({"since": "v1.0"})).await, "v1 since v1.0");
    let refused = run_tool("notes-kit/peek", json!({})).await;
    assert!(refused.contains("plugin notes-kit may not fetch example.com (add it to permissions.net)"), "{refused}");

    notes_kit(&e.plugins.join("notes-kit"), "v2-edited");
    e.call("POST", "/api/plugins/reload", None).await;
    assert_eq!(run_tool("notes-kit/draft", json!({"since": "v1.0"})).await, "v2-edited since v1.0");

    // A syntax error fails only the code: the plugin keeps running without tools.
    write(&e.plugins.join("notes-kit/dev.openagentd/plugin.ts"), "export default {");
    let (_, list) = e.call("POST", "/api/plugins/reload", None).await;
    let kit = e.bundle(&list, "notes-kit");
    assert_eq!((kit["state"].as_str(), kit["tools"].clone()), (Some("running"), json!([])), "{kit}");
    assert!(kit["errors"][0].as_str().unwrap().starts_with("dev.openagentd/plugin.ts: "), "{kit}");
    assert!(appv3_agent::plugins::extra_tools().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turning_a_plugin_off_removes_what_it_provides_until_it_is_on_again() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    notes_kit(&e.plugins.join("notes-kit"), "v1");
    appv3_api::plugins::reload().await;
    assert_eq!(module_state("plugin:notes-kit"), Some("running"));

    let (st, kit) = e.call("PUT", "/api/plugins/bundles/notes-kit", Some(json!({"enabled": false}))).await;
    assert_eq!((st, kit["state"].as_str(), kit["enabled"].as_bool()), (StatusCode::OK, Some("disabled"), Some(false)), "{kit}");
    assert_eq!(module_state("plugin:notes-kit"), None);
    assert!(appv3_agent::plugins::extra_tools().is_empty());
    assert!(appv3_plugins::disabled(&appv3_core::settings().config_dir).contains("notes-kit"));

    let (st, kit) = e.call("PUT", "/api/plugins/bundles/notes-kit", Some(json!({"enabled": true}))).await;
    assert_eq!((st, kit["state"].as_str()), (StatusCode::OK, Some("running")), "{kit}");
    assert_eq!(run_tool("notes-kit/draft", json!({"since": "v2"})).await, "v1 since v2");

    let (st, _) = e.call("PUT", "/api/plugins/bundles/nope", Some(json!({"enabled": false}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = e.call("PUT", "/api/plugins/bundles/notes-kit", Some(json!({"enabled": "maybe"}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
}

/// The `mcp` tool lists a plugin's tools under the plugin's name, so a
/// server of the user's with that name hides them: Settings says so.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_users_mcp_server_named_like_a_plugin_is_flagged_on_the_plugin() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    notes_kit(&e.plugins.join("notes-kit"), "v1");
    appv3_api::plugins::reload().await;
    let clash = "Agents cannot use this plugin's tools: an MCP server in mcp.json is also named 'notes-kit'. Rename that server to use them.";

    let (st, v) = e.call("POST", "/api/mcp/servers", Some(json!({"name": "notes-kit", "server": {"transport": "stdio", "command": "openagentd-test-no-such-command"}}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (_, list) = e.call("GET", "/api/plugins", None).await;
    assert!(e.bundle(&list, "notes-kit")["warnings"].as_array().unwrap().iter().any(|w| w == clash), "{list}");

    let (st, _) = e.call("DELETE", "/api/mcp/servers/notes-kit", None).await;
    assert_eq!(st, StatusCode::OK);
    let (_, list) = e.call("GET", "/api/plugins", None).await;
    assert!(!e.bundle(&list, "notes-kit")["warnings"].as_array().unwrap().iter().any(|w| w == clash), "{list}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugins_hooks_wrap_tool_calls_until_it_is_removed() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    write(&e.plugins.join("scrub-kit/plugin.json"), r#"{"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "scrub-kit"}"#);
    write(
        &e.plugins.join("scrub-kit/dev.openagentd/plugin.ts"),
        r#"export default {
  hooks: {
    "tool.before"(input, output) { if (input.tool === "shell") output.args.command = "echo safe" },
    "tool.after"(input, output) { output.output = output.output.replace("secret", "[redacted]") },
  },
}
"#,
    );
    appv3_api::plugins::reload().await;
    let hooks = appv3_agent::plugins::bundle_tool_hooks();
    assert_eq!(hooks.iter().map(|h| h.id().to_string()).collect::<Vec<_>>(), ["scrub-kit"]);
    let call = appv3_providers::ToolCall::new("c1", "shell", r#"{"command": "cat .env"}"#);
    let ctx = appv3_agent::plugins::PluginCtx { tool: "shell", session_id: None, run_id: "r1", agent_name: "code", call_id: "c1" };
    let (text, ()) =
        appv3_agent::plugins::wrap_tool_call(&hooks, ctx, &call, |c| async move { Ok::<_, ()>((format!("ran {} with secret", c.function.arguments), ())) }).await.unwrap();
    assert_eq!(text, r#"ran {"command":"echo safe"} with [redacted]"#);

    std::fs::remove_dir_all(e.plugins.join("scrub-kit")).unwrap();
    appv3_api::plugins::reload().await;
    assert!(appv3_agent::plugins::bundle_tool_hooks().is_empty(), "a removed plugin's hooks stop wrapping calls");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_copied_into_the_folder_loads_without_a_restart() {
    let e = env().await;
    let _g = serial().lock().await;
    e.fresh().await;
    appv3_api::config_watch::start();
    tokio::time::sleep(Duration::from_millis(500)).await;
    // Built beside the folder, then moved in at once, as `agentd plugin add` does.
    let staging = e.plugins.join(".staging-review-kit");
    copy_dir(&fixture("review-kit"), &staging);
    std::fs::rename(&staging, e.plugins.join("review-kit")).unwrap();
    // The watcher starts on its own thread and misses changes made before it
    // watches; on a busy machine that can be after the move, so the manifest
    // is saved again now and then until the plugin loads.
    let manifest = e.plugins.join("review-kit/plugin.json");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut resave = Instant::now() + Duration::from_secs(2);
    while module_state("plugin:review-kit") != Some("running") {
        assert!(
            Instant::now() < deadline,
            "the watcher never loaded the new plugin: found {:?}, modules {:?}",
            appv3_api::plugins::found().iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
            appv3_kernel::global().status().iter().map(|m| (m.id.clone(), m.state.as_str())).collect::<Vec<_>>()
        );
        if Instant::now() >= resave {
            std::fs::write(&manifest, std::fs::read(&manifest).unwrap()).unwrap();
            resave = Instant::now() + Duration::from_secs(2);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(appv3_agent::skills::discover_skills(None).iter().any(|s| s.name == "review-kit/code-review"));
}
