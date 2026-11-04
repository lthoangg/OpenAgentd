use super::*;

type Log = Arc<Mutex<Vec<String>>>;

fn log() -> Log {
    Arc::new(Mutex::new(vec![]))
}

fn entries(l: &Log) -> Vec<String> {
    l.lock().unwrap().clone()
}

/// A module that records its start and stop in `l`, and fails to start
/// when `fail` is set.
fn rec(l: &Log, id: &'static str, deps: &[&'static str], fail: bool) -> FnModule {
    let (a, b) = (l.clone(), l.clone());
    FnModule::new(id)
        .depends_on(deps)
        .on_start(move || {
            a.lock().unwrap().push(format!("start {id}"));
            async move {
                if fail {
                    anyhow::bail!("{id} broke")
                }
                Ok(())
            }
        })
        .on_stop(move || {
            b.lock().unwrap().push(format!("stop {id}"));
            async {}
        })
}

fn state_of(k: &Kernel, id: &str) -> (State, Option<String>) {
    let s = k.status().into_iter().find(|s| s.id == id).unwrap();
    (s.state, s.error)
}

#[tokio::test]
async fn starts_in_dependency_order_and_stops_in_reverse() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "scheduler", &["sessions"], false)).unwrap();
    k.add(rec(&l, "otel", &[], false)).unwrap();
    k.add(rec(&l, "sessions", &["otel"], false)).unwrap();
    k.start_all().await.unwrap();
    k.stop_all().await;
    assert_eq!(entries(&l), ["start otel", "start sessions", "start scheduler", "stop scheduler", "stop sessions", "stop otel"]);
}

#[tokio::test]
async fn independent_modules_keep_the_order_they_were_added() {
    let (k, l) = (Kernel::new(), log());
    for id in ["c", "a", "b"] {
        k.add(rec(&l, id, &[], false)).unwrap();
    }
    k.start_all().await.unwrap();
    assert_eq!(entries(&l), ["start c", "start a", "start b"]);
    assert_eq!(k.status().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
}

#[tokio::test]
async fn an_optional_module_that_fails_blocks_only_its_dependents() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "lsp", &[], true)).unwrap();
    k.add(rec(&l, "lsp-ui", &["lsp"], false)).unwrap();
    k.add(rec(&l, "mcp", &[], false)).unwrap();
    k.start_all().await.unwrap();
    assert_eq!(state_of(&k, "lsp"), (State::Failed, Some("lsp broke".into())));
    assert_eq!(state_of(&k, "lsp-ui"), (State::Blocked, Some("needs lsp, which is failed".into())));
    assert_eq!(state_of(&k, "mcp"), (State::Running, None));
    assert_eq!(entries(&l), ["start lsp", "start mcp"]);
}

#[tokio::test]
async fn a_critical_module_that_fails_stops_the_started_ones_and_fails_the_boot() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "otel", &[], false)).unwrap();
    k.add(rec(&l, "mcp", &[], false)).unwrap();
    k.add(rec(&l, "agents", &[], true).critical(true)).unwrap();
    k.add(rec(&l, "scheduler", &[], false)).unwrap();
    let err = k.start_all().await.unwrap_err();
    assert_eq!(err.to_string(), "agents broke", "the module's own error comes back");
    assert_eq!(entries(&l), ["start otel", "start mcp", "start agents", "stop mcp", "stop otel"]);
    assert_eq!(state_of(&k, "scheduler").0, State::Pending);
    assert_eq!(state_of(&k, "otel").0, State::Stopped);
}

#[tokio::test]
async fn a_critical_module_that_cannot_start_fails_the_boot() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "lsp", &[], true)).unwrap();
    k.add(rec(&l, "scheduler", &["lsp"], false).critical(true)).unwrap();
    let err = k.start_all().await.unwrap_err();
    assert_eq!(err.to_string(), "module scheduler cannot start: needs lsp, which is failed");
}

#[tokio::test]
async fn a_subset_boots_and_a_missing_dependency_blocks_its_module() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "sessions", &[], false)).unwrap();
    k.add(rec(&l, "scheduler", &["sessions", "agents"], false)).unwrap();
    k.start_all().await.unwrap();
    assert_eq!(state_of(&k, "sessions").0, State::Running);
    assert_eq!(state_of(&k, "scheduler"), (State::Blocked, Some("needs agents, which is not installed".into())));
}

#[tokio::test]
async fn a_dependency_cycle_blocks_the_modules_in_it() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "a", &["b"], false)).unwrap();
    k.add(rec(&l, "b", &["a"], false)).unwrap();
    k.add(rec(&l, "c", &[], false)).unwrap();
    k.start_all().await.unwrap();
    assert_eq!(state_of(&k, "a"), (State::Blocked, Some("dependency cycle".into())));
    assert_eq!(state_of(&k, "b").0, State::Blocked);
    assert_eq!(entries(&l), ["start c"]);
}

struct Skill(&'static str);

/// A module that contributes the skills it was given.
struct Skills {
    id: &'static str,
    skills: Vec<&'static str>,
}

#[async_trait::async_trait]
impl Module for Skills {
    fn id(&self) -> &str {
        self.id
    }
    fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
        for s in &self.skills {
            r.add(Skill(s));
        }
        r.add(42u32);
        Ok(())
    }
}

fn skills(k: &Kernel) -> Vec<String> {
    k.contributions_by_module::<Skill>().iter().map(|(m, s)| format!("{m}/{}", s.0)).collect()
}

#[tokio::test]
async fn contributions_carry_their_module_and_leave_with_it() {
    let k = Kernel::new();
    k.add(Skills { id: "plugin:a", skills: vec!["review", "notes"] }).unwrap();
    k.add(Skills { id: "plugin:b", skills: vec!["deploy"] }).unwrap();
    assert!(skills(&k).is_empty(), "nothing before the modules start");
    k.start_all().await.unwrap();
    assert_eq!(skills(&k), ["plugin:a/review", "plugin:a/notes", "plugin:b/deploy"]);
    assert_eq!(k.contributions::<u32>().len(), 2, "each type has its own list");
    k.stop("plugin:a").await;
    assert_eq!(skills(&k), ["plugin:b/deploy"]);
    k.remove("plugin:b").await;
    assert!(skills(&k).is_empty());
    assert_eq!(k.status().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["plugin:a"]);
}

#[tokio::test]
async fn a_failed_start_leaves_no_contributions() {
    struct Broken;
    #[async_trait::async_trait]
    impl Module for Broken {
        fn id(&self) -> &str {
            "plugin:broken"
        }
        fn register(&self, r: &mut Registrar) -> anyhow::Result<()> {
            r.add(Skill("half"));
            Ok(())
        }
        async fn start(&self, _k: &Kernel) -> anyhow::Result<()> {
            anyhow::bail!("manifest is invalid")
        }
    }
    let k = Kernel::new();
    k.add(Broken).unwrap();
    k.start_all().await.unwrap();
    assert!(skills(&k).is_empty());
    assert_eq!(state_of(&k, "plugin:broken"), (State::Failed, Some("manifest is invalid".into())));
}

#[tokio::test]
async fn restart_stops_dependents_first_and_starts_them_again() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "mcp", &[], false)).unwrap();
    k.add(rec(&l, "plugin:x", &["mcp"], false)).unwrap();
    k.add(rec(&l, "other", &[], false)).unwrap();
    k.start_all().await.unwrap();
    l.lock().unwrap().clear();
    k.restart("mcp").await.unwrap();
    assert_eq!(entries(&l), ["stop plugin:x", "stop mcp", "start mcp", "start plugin:x"]);
    assert!(k.status().iter().all(|s| s.state == State::Running));
    // After a runtime restart the module stops before the ones that
    // started earlier.
    l.lock().unwrap().clear();
    k.stop_all().await;
    assert_eq!(entries(&l), ["stop plugin:x", "stop mcp", "stop other"]);
}

#[tokio::test]
async fn restart_retries_a_module_that_failed() {
    let k = Kernel::new();
    let fails = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let f = fails.clone();
    k.add(FnModule::new("plugin:x").on_start(move || {
        let fail = f.load(std::sync::atomic::Ordering::SeqCst);
        async move {
            if fail {
                anyhow::bail!("syntax error")
            }
            Ok(())
        }
    }))
    .unwrap();
    k.start_all().await.unwrap();
    assert_eq!(state_of(&k, "plugin:x").0, State::Failed);
    fails.store(false, std::sync::atomic::Ordering::SeqCst);
    k.restart("plugin:x").await.unwrap();
    assert_eq!(state_of(&k, "plugin:x"), (State::Running, None));
}

#[tokio::test]
async fn a_running_module_cannot_be_replaced_but_a_stopped_one_can() {
    let (k, l) = (Kernel::new(), log());
    k.add(rec(&l, "plugin:x", &[], false)).unwrap();
    k.start_all().await.unwrap();
    assert!(k.add(rec(&l, "plugin:x", &[], false)).is_err());
    k.stop("plugin:x").await;
    k.add(rec(&l, "plugin:x", &["mcp"], false)).unwrap();
    assert_eq!(k.status()[0].deps, ["mcp"]);
    assert_eq!(k.status()[0].state, State::Pending);
}
