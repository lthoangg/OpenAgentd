//! A scheduled run aimed at the user's own session does not start a turn
//! beside a message the user is sending. The scheduler checked "is a turn
//! running?" without the session's `user_message_lock`, so a message the
//! chat route was sending under that lock could start a second turn. The
//! manager and scheduler are process-wide, so this file is its own binary.

mod common;

use appv3_agent::loader::ProviderFactory;
use appv3_agent::scheduler::{self, TaskCreate};
use appv3_agent::session::UserMessage;
use appv3_agent::{manager, service};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::sync::Arc;

use common::{setup_roots, wait_until_async};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scheduled_run_waits_for_a_message_being_sent_and_then_skips() {
    let tmp = tempfile::tempdir().unwrap();
    setup_roots(tmp.path());
    let pool = appv3_db::create_pool(tmp.path().join("oad.db")).await.unwrap();
    let mock = Arc::new(MockProvider::new(vec![MockProvider::hang(), MockProvider::hang()]));
    let shared: Arc<dyn LlmProvider> = mock.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(shared.clone()));
    manager::init(pool.clone(), factory);
    scheduler::init(pool.clone());
    let dir = tmp.path().join("project");
    std::fs::create_dir_all(&dir).unwrap();
    let ws = manager::validate_workspace(&dir.display().to_string(), true).unwrap();
    let sid = uuid::Uuid::now_v7().to_string();
    let user = manager::get_or_start_agent_session(&ws, Some(&sid)).await.unwrap().expect("the user's session");
    let s = scheduler::scheduler();
    let t = s
        .create(TaskCreate {
            name: "nudge".into(),
            slug: Some("nudge".into()),
            workspace: ws.clone(),
            schedule_type: "every".into(),
            every_seconds: Some(3600),
            timezone: "UTC".into(),
            prompt: "nudge".into(),
            session_id: Some(sid.clone()),
            enabled: false,
            ..Default::default()
        })
        .await
        .unwrap();

    // The chat route holds the lock while it sends; the run fires meanwhile.
    let sending = user.user_message_lock.lock().await;
    s.trigger(&t.slug).await.unwrap();
    wait_until_async("the run to fire", async || s.get_task(&t.slug).await.unwrap().unwrap().status == "running").await;
    user.handle_user_message(UserMessage { content: "mine".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    drop(sending);
    wait_until_async("the run to settle", async || s.get_task(&t.slug).await.unwrap().unwrap().status != "running").await;

    let task = s.get_task(&t.slug).await.unwrap().unwrap();
    assert_eq!((task.status.as_str(), task.run_count), ("pending", 0), "the scheduled run started a turn beside the user's");
    assert_eq!(mock.calls.lock().unwrap().len(), 1, "two turns called the model");
    service::interrupt_agent(&user, Some(&sid)).await;
}
