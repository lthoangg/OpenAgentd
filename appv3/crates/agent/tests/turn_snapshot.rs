//! The snapshot captured before a turn must precede its workspace edits,
//! and undo/redo must restore the corresponding workspace boundary.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{revert, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

struct EditFile(PathBuf);

#[async_trait::async_trait]
impl Tool for EditFile {
    fn name(&self) -> &str {
        "edit_test_file"
    }

    async fn run(&self, _: &ToolContext, _: Value) -> ToolResult {
        tokio::fs::write(&self.0, "after\n").await.unwrap();
        Ok(ToolOutput::text("Updated."))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_and_redo_restore_the_boundaries_around_a_turns_edits() {
    let root = tempfile::tempdir().unwrap();
    for (key, directory) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(key, root.path().join(directory));
    }
    std::env::set_var("HOME", root.path().join("home"));
    std::fs::create_dir_all(root.path().join("config")).unwrap();
    std::fs::write(root.path().join("config/settings.yaml"), "title_generation:\n  enabled: false\n").unwrap();
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
    let workspace = root.path().join("project");
    std::fs::create_dir_all(&workspace).unwrap();
    let file = workspace.join("example.txt");
    std::fs::write(&file, "before\n").unwrap();
    let pool = appv3_db::create_pool(root.path().join("snapshot.db")).await.unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![MockProvider::tool_call("edit_1", "edit_test_file", "{}"), MockProvider::text("Done.")]));
    let shared = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
    let agent = Agent::new(provider, "worker", "You are a test agent.", vec![Arc::new(EditFile(file.clone()))], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(workspace.display().to_string()), pool.clone(), factory, None);
    let sid = uuid::Uuid::now_v7().to_string();

    session.handle_user_message(UserMessage { content: "edit the file".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("the editing turn finishes");
    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    assert_eq!(session.state(), "idle", "the turn failed: {:?}", session.last_error());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n", "the tool did not edit its fixture: {rows:?}");
    assert!(rows[0].snapshot().is_some(), "the prompt owns its pre-edit snapshot");

    let undone = session.handle_boundary_command(&sid, "undo", "Nothing to undo.", revert::undo_session_messages).await.unwrap();
    assert!(undone.applied);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before\n");

    let redone = session.handle_boundary_command(&sid, "redo", "Nothing to redo.", revert::redo_session_messages).await.unwrap();
    assert!(redone.applied);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");
}
