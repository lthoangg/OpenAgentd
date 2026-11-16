//! The snapshot captured before a turn must precede its workspace edits,
//! and undo/redo must restore the corresponding workspace boundary — or,
//! for a messages-only undo, leave the files alone.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::revert::{self, BoundaryShift};
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::Agent;
use appv3_db::DbPool;
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolResult};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Writes `turn N` on its Nth call, so each turn leaves a distinct file.
struct EditFile {
    path: PathBuf,
    calls: AtomicUsize,
}

#[async_trait::async_trait]
impl Tool for EditFile {
    fn name(&self) -> &str {
        "edit_test_file"
    }

    async fn run(&self, _: &ToolContext, _: Value) -> ToolResult {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::fs::write(&self.path, format!("turn {n}\n")).await.unwrap();
        Ok(ToolOutput::text("Updated."))
    }
}

struct Fixture {
    session: Arc<AgentSession>,
    pool: DbPool,
    sid: String,
    file: PathBuf,
}

impl Fixture {
    /// A session in `root/<name>` whose file starts as `turn 0` and that has
    /// run `turns` editing turns.
    async fn new(root: &Path, name: &str, turns: usize) -> Self {
        let workspace = root.join(name);
        std::fs::create_dir_all(&workspace).unwrap();
        let file = workspace.join("example.txt");
        std::fs::write(&file, "turn 0\n").unwrap();
        let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
        let script: Vec<MockTurn> = (0..turns).flat_map(|i| [MockProvider::tool_call(&format!("edit_{i}"), "edit_test_file", "{}"), MockProvider::text("Done.")]).collect();
        let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(script));
        let shared = provider.clone();
        let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
        let tool = Arc::new(EditFile { path: file.clone(), calls: AtomicUsize::new(0) });
        let agent = Agent::new(provider, "worker", "You are a test agent.", vec![tool], Some("mock:mock".into()));
        let session = AgentSession::new(agent, None, Some(workspace.display().to_string()), pool.clone(), factory, None);
        let fixture = Self { session, pool, sid: uuid::Uuid::now_v7().to_string(), file };
        for n in 1..=turns {
            let message = UserMessage { content: format!("edit {n}"), session_id: fixture.sid.clone(), origin: "user".into(), ..Default::default() };
            fixture.session.handle_user_message(message).await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), fixture.session.wait_turn_finished()).await.expect("the editing turn finishes");
            assert_eq!(fixture.session.state(), "idle", "the turn failed: {:?}", fixture.session.last_error());
            assert_eq!(fixture.read(), format!("turn {n}\n"), "the tool did not edit its fixture");
        }
        fixture
    }

    fn read(&self) -> String {
        std::fs::read_to_string(&self.file).unwrap()
    }

    async fn undo(&self, keep_files: bool) -> BoundaryShift {
        let op = move |pool, sid| revert::undo_session_messages(pool, sid, keep_files);
        let shift = self.session.handle_boundary_command(&self.sid, "undo", "Nothing to undo.", op).await.unwrap();
        assert!(shift.applied);
        shift
    }

    async fn redo(&self) {
        assert!(self.session.handle_boundary_command(&self.sid, "redo", "Nothing to redo.", revert::redo_session_messages).await.unwrap().applied);
    }

    async fn redo_all(&self) {
        assert!(self.session.handle_boundary_command(&self.sid, "redo", "Nothing to redo.", revert::redo_all_session_messages).await.unwrap().applied);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_and_redo_restore_the_boundaries_around_a_turns_edits() {
    // Settings and env are process-wide, so every scenario shares this one test.
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

    // Undo and redo with files: the workspace follows the boundary.
    let f = Fixture::new(root.path(), "files", 1).await;
    let rows = appv3_db::llm_window_rows(&f.pool, &f.sid, false).await.unwrap();
    assert!(rows[0].snapshot().is_some(), "the prompt owns its pre-edit snapshot");
    f.undo(false).await;
    assert_eq!(f.read(), "turn 0\n");
    f.redo().await;
    assert_eq!(f.read(), "turn 1\n");

    // Undo messages: the turn leaves the conversation, its edit stays, and
    // neither redo nor redo-all touches files edited in the meantime.
    let f = Fixture::new(root.path(), "messages", 1).await;
    let shift = f.undo(true).await;
    assert!(shift.added.is_empty() && shift.modified.is_empty() && shift.removed.is_empty());
    assert_eq!(f.read(), "turn 1\n");
    std::fs::write(&f.file, "mine\n").unwrap();
    f.redo().await;
    assert_eq!(f.read(), "mine\n", "redo after a messages-only undo leaves files alone");
    f.undo(true).await;
    f.redo_all().await;
    assert_eq!(f.read(), "mine\n", "redo all after a messages-only undo leaves files alone");

    // Messages-only, then files: the file step rolls back to before turn 1,
    // and redo walks the files forward to the live tip.
    let f = Fixture::new(root.path(), "kept-then-files", 2).await;
    f.undo(true).await;
    assert_eq!(f.read(), "turn 2\n");
    f.undo(false).await;
    assert_eq!(f.read(), "turn 0\n");
    f.redo().await;
    assert_eq!(f.read(), "turn 1\n");
    f.redo().await;
    assert_eq!(f.read(), "turn 2\n");

    // Files, then messages-only: the messages step leaves the rolled-back
    // files, and redo all still returns to the live tip.
    let f = Fixture::new(root.path(), "files-then-kept", 2).await;
    f.undo(false).await;
    assert_eq!(f.read(), "turn 1\n");
    f.undo(true).await;
    assert_eq!(f.read(), "turn 1\n");
    f.redo().await;
    assert_eq!(f.read(), "turn 1\n");
    f.redo_all().await;
    assert_eq!(f.read(), "turn 2\n");
}
