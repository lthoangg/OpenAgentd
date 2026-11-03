//! Bundled skills point the agent at reference files inside the (denied)
//! cache dir: the index must render real paths that `read` can open while
//! write tools stay refused, and a dropped skill must not linger.

use appv3_tools::denied::DeniedPaths;
use appv3_tools::{Tool, ToolContext, ToolOutput};
use serde_json::json;
use std::sync::Arc;

fn setup_env(root: &std::path::Path) {
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

fn text(out: ToolOutput) -> String {
    match out {
        ToolOutput::Text(t) => t,
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn self_healing_references_are_readable_but_not_writable() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let stale = root.path().join("cache/v3-builtin-skills/skill-installer");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("SKILL.md"), "---\nname: skill-installer\ndescription: old\n---\nold\n").unwrap();

    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let ctx = ToolContext {
        session_id: None,
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: Arc::new(DeniedPaths::new(&ws, None)),
        workspace: Some(ws.display().to_string()),
        output: None,
        metadata: Default::default(),
        messages: None,
    };

    let index = text(appv3_agent::skills::SkillTool.run(&ctx, json!({"skill_name": "self-healing"})).await.unwrap());
    assert!(!stale.exists(), "a skill dropped from the bundle is pruned");
    let line = index.lines().find(|l| l.contains("references/mcp.md")).expect("index links the MCP reference");
    let path = line.split('`').find(|s| s.ends_with("references/mcp.md")).expect("rendered path");
    assert!(std::path::Path::new(path).is_absolute(), "{{SKILL_DIR}} renders to an absolute path: {path}");

    let read = std::sync::Arc::new(appv3_tools::read::ReadTool) as appv3_tools::ToolRef;
    let body = text(read.run(&ctx, json!({"path": path})).await.unwrap());
    assert!(body.contains("# MCP servers"), "{body}");
    assert!(ctx.denied.validate_path(path).is_err(), "write tools keep the cache denial");

    let missing = text(appv3_agent::skills::SkillTool.run(&ctx, json!({"skill_name": "skill-installer"})).await.unwrap());
    assert!(missing.starts_with("Skill 'skill-installer' not found"), "{missing}");
}
