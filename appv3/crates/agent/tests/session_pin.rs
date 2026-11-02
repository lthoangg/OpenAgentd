//! A session pinned to one stored credential builds its turn's provider
//! with the pin, only for a model of that credential's provider, and its
//! members follow the lead's pin. Its own binary: the env and the
//! credential store are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::AgentSession;
use appv3_agent::Agent;
use appv3_core::credentials as store;
use appv3_providers::mock::MockProvider;
use appv3_providers::pool::PIN_KWARG;
use appv3_providers::{Kwargs, LlmProvider};
use std::sync::{Arc, Mutex};

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
    std::env::remove_var("ROUTER9_API_KEY");
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

fn add(provider: &str, label: &str) -> String {
    store::update(|f| {
        let mut c = store::Credential::new(label);
        c.values.insert("ROUTER9_API_KEY".into(), format!("{label}-key"));
        f.provider_mut(provider).push(c.clone());
        c.id
    })
    .unwrap()
}

/// Every build a factory was asked for: the model and its kwargs.
type Builds = Arc<Mutex<Vec<(Option<String>, Kwargs)>>>;

/// A factory that records the kwargs of every build.
fn recording() -> (ProviderFactory, Builds) {
    let builds: Builds = Default::default();
    let seen = builds.clone();
    let f: ProviderFactory = Arc::new(move |m: Option<&str>, kw: Kwargs| {
        seen.lock().unwrap().push((m.map(String::from), kw));
        Ok(Arc::new(MockProvider::new(vec![MockProvider::text("ok")])) as Arc<dyn LlmProvider>)
    });
    (f, builds)
}

/// One test: the steps share the process-wide env and credential store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_pins() {
    a_pin_reaches_the_provider_only_for_its_own_provider().await;
    a_member_follows_the_lead_pin().await;
}

async fn a_pin_reaches_the_provider_only_for_its_own_provider() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let work = add("router9", "Work");
    let (factory, builds) = recording();
    let agent = Agent::new(Arc::new(MockProvider::new(vec![])), "code", "You help.", vec![], Some("router9:m".into()));
    let session = AgentSession::new(agent.clone(), None, Some("/tmp".into()), pool.clone(), factory, None);

    // No override and no pin: the agent's own provider, nothing built.
    let rp = session.resolve_runtime_provider(&agent, None, None, None).unwrap();
    assert!(rp.runtime.is_none());

    // A pin alone builds a provider for the agent's model, carrying it.
    let rp = session.resolve_runtime_provider(&agent, None, None, Some(&work)).unwrap();
    assert!(rp.runtime.is_some());
    let (model, kw) = builds.lock().unwrap().last().cloned().unwrap();
    assert_eq!(model.as_deref(), Some("router9:m"));
    assert_eq!(kw.get(PIN_KWARG).and_then(|v| v.as_str()), Some(work.as_str()));

    // A model of another provider ignores the pin.
    session.resolve_runtime_provider(&agent, Some("other:m"), None, Some(&work)).unwrap();
    let (_, kw) = builds.lock().unwrap().last().cloned().unwrap();
    assert!(kw.get(PIN_KWARG).is_none(), "{kw:?}");
}

async fn a_member_follows_the_lead_pin() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let work = add("router9", "Work");
    let lead = appv3_db::create_session(&pool, appv3_db::NewSession { workspace: "/tmp".into(), credential_id: Some(work.clone()), ..Default::default() }).await.unwrap();
    let lead_id = appv3_db::codec::api_uuid(&lead.id);
    let child = appv3_db::create_session(&pool, appv3_db::NewSession { workspace: "/tmp".into(), parent_session_id: Some(lead_id.clone()), ..Default::default() }).await.unwrap();
    let (factory, _) = recording();
    let agent = Agent::new(Arc::new(MockProvider::new(vec![])), "explorer#1", "You help.", vec![], Some("router9:m".into()));
    let member = AgentSession::new(agent, Some(appv3_db::codec::api_uuid(&child.id)), Some("/tmp".into()), pool.clone(), factory, Some(lead_id.clone()));

    assert_eq!(member.pinned_credential(&child).await.as_deref(), Some(work.as_str()));
    appv3_db::update_session(&pool, &lead_id, appv3_db::SessionUpdate { credential_id: Some(None), ..Default::default() }).await.unwrap();
    assert_eq!(member.pinned_credential(&child).await, None, "the lead back on Auto takes its members with it");
}
