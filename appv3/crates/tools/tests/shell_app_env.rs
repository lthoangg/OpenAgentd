//! The server's own mode and path variables (`APP_ENV`, `OPENAGENTD_*`) are
//! set by its launcher (the desktop app, `agentd`). Commands the agent runs
//! must not inherit them: a project that reads `APP_ENV` would see the app's
//! `production`, and a development build started from the agent's shell
//! would open the installed app's database. Separate test binary: it
//! mutates the environment.
#![cfg(unix)]

use appv3_tools::{shell::ShellTool, DeniedPaths, Tool, ToolContext, ToolOutput};
use std::sync::Arc;

#[tokio::test]
async fn agent_shell_does_not_inherit_the_servers_mode_or_paths() {
    let dir = tempfile::tempdir().unwrap();
    // What the desktop app passes to its server.
    std::env::set_var("APP_ENV", "oad-mode-canary");
    std::env::set_var("OPENAGENTD_DATA_DIR", "/oad-path-canary");
    // Something the user exported before starting the server.
    std::env::set_var("OAD_TEST_USER_VAR", "oad-user-value");

    let ctx = ToolContext {
        session_id: None,
        agent_name: "t".into(),
        tool_call_id: "c".into(),
        denied: Arc::new(DeniedPaths::with(dir.path(), None, Some(vec![]), Some(vec![]))),
        workspace: None,
        output: None,
        metadata: Default::default(),
        messages: None,
    };
    let out = ShellTool.run(&ctx, serde_json::json!({"command": "env"})).await.unwrap();
    let ToolOutput::Text(text) = out else { panic!("unexpected output {out:?}") };
    assert!(text.contains("oad-user-value"), "user env must pass through: {text}");
    assert!(!text.contains("oad-mode-canary"), "APP_ENV reached the agent shell: {text}");
    assert!(!text.contains("oad-path-canary"), "OPENAGENTD_* reached the agent shell: {text}");
}
