//! One turn per session: a command that starts a turn checks that the
//! session is free and claims it in one step. Checking first and claiming
//! after an await let two commands sent together both start a turn.

use crate::common;

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::AgentSession;
use appv3_agent::Agent;
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::sync::Arc;
use std::time::Duration;

async fn session(root: &std::path::Path, name: &str) -> (Arc<AgentSession>, String, String) {
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join(name);
    std::fs::create_dir_all(&ws).unwrap();
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new((0..4).map(|_| MockProvider::text("Done.")).collect()));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, name, "You are a test agent.", vec![], Some("mock:mock".into()));
    let ws = ws.display().to_string();
    let session = AgentSession::new(agent, None, Some(ws.clone()), pool, factory, None);
    (session, uuid::Uuid::now_v7().to_string(), ws)
}

#[tokio::test]
async fn two_compacts_sent_together_start_one_turn() {
    let tmp = tempfile::tempdir().unwrap();
    common::setup_roots(tmp.path());
    let (s, sid, ws) = session(tmp.path(), "compact").await;
    s.handle_compact(&sid, Some(&ws)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), s.wait_turn_finished()).await.expect("the turn finishes");

    let (a, b) = tokio::join!(s.handle_compact(&sid, Some(&ws)), s.handle_compact(&sid, Some(&ws)));

    assert_eq!([a.is_ok(), b.is_ok()].into_iter().filter(|ok| *ok).count(), 1, "both compacts started a turn: {a:?} {b:?}");
    tokio::time::timeout(Duration::from_secs(10), s.wait_turn_finished()).await.expect("the turn finishes");

    let (c, d) = tokio::join!(s.handle_continue(&sid, Some(&ws), None, None), s.handle_continue(&sid, Some(&ws), None, None));
    assert_eq!([c.is_ok(), d.is_ok()].into_iter().filter(|ok| *ok).count(), 1, "both continues started a turn: {c:?} {d:?}");
    tokio::time::timeout(Duration::from_secs(10), s.wait_turn_finished()).await.expect("the turn finishes");
}
