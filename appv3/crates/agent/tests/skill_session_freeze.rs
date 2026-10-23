//! The `skill` tool's description (every skill's name and description) sits
//! in the cached tools block, so it is fixed for a session; a skill's body
//! is read from disk on every load, so edits to it apply right away.

use appv3_tools::denied::DeniedPaths;
use appv3_tools::{Tool, ToolContext, ToolOutput};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;

fn setup_env(root: &Path) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

fn write_skill(ws: &Path, description: &str, body: &str) {
    let dir = ws.join(".agents/skills/deploy");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: deploy\ndescription: {description}\n---\n{body}\n")).unwrap();
}

fn ctx(ws: &Path, session: &str) -> ToolContext {
    ToolContext {
        session_id: Some(session.into()),
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(DeniedPaths::new(ws, Some(session.into()))),
        workspace: Some(ws.display().to_string()),
        output: None,
        metadata: Default::default(),
        messages: None,
    }
}

fn description(ctx: &ToolContext) -> String {
    appv3_agent::skills::SkillTool.definition_for(ctx).pointer("/function/description").and_then(|d| d.as_str()).unwrap().to_string()
}

fn text(out: ToolOutput) -> String {
    match out {
        ToolOutput::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn skill_list_is_fixed_for_a_session_and_bodies_load_fresh() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let ws = root.path().join("project");
    write_skill(&ws, "Ship the app.", "Step one.");
    let session = ctx(&ws, "skill-freeze-a");

    let first = description(&session);
    assert!(first.contains("Ship the app."), "{first}");
    assert!(text(appv3_agent::skills::SkillTool.run(&session, json!({"skill_name": "deploy"})).await.unwrap()).contains("Step one."));

    write_skill(&ws, "Ship the app to production.", "Step two.");
    assert_eq!(description(&ctx(&ws, "skill-freeze-a")), first, "the tools block stays byte-identical for the session");
    assert!(description(&ctx(&ws, "skill-freeze-b")).contains("Ship the app to production."), "the next session sees the new description");

    // Same run (same metadata), loaded a second time after the edit.
    let again = text(appv3_agent::skills::SkillTool.run(&session, json!({"skill_name": "deploy"})).await.unwrap());
    assert!(again.contains("Step two."), "a load reads the skill's current body: {again}");
}
