use super::*;

#[test]
fn dep_specs() {
    assert_eq!(split_dep_spec("ruff==0.16.1"), ("ruff".into(), Some("0.16.1".into())));
    assert_eq!(split_dep_spec("ty>=0.0.33,<0.1"), ("ty".into(), None));
    assert_eq!(split_dep_spec("Ruff[x] === 1.2 ; python_version>'3'"), ("ruff".into(), None));
    assert_eq!(split_dep_spec("Ruff === 1.2 ; python_version>'3'"), ("ruff".into(), Some("1.2".into())));
    assert_eq!(split_dep_spec("  "), ("".into(), None));
}

#[test]
fn suffixes() {
    assert_eq!(py_suffix(Path::new("a/b.PY")), Some(".PY".into()));
    assert_eq!(py_suffix(Path::new(".bashrc")), None);
    assert_eq!(lang_for_path(Path::new("x.tsx")), Some("typescriptreact"));
}

/// One `typescript-language-server` serves `.ts`, `.tsx`, `.js` and
/// `.jsx`; keying it by language started a second server per project.
#[test]
fn ts_family_files_share_one_server_per_project_and_command() {
    let cmd = sv(&["typescript-language-server", "--stdio"]);
    let ts = client_key("/w", "typescript", &cmd);
    for lang in ["typescriptreact", "javascript", "javascriptreact"] {
        assert_eq!(client_key("/w", lang, &cmd), ts, "{lang}");
    }
    assert_ne!(client_key("/other", "typescript", &cmd), ts, "a project gets its own server");
    assert_ne!(client_key("/w", "typescript", &sv(&["other-ts-server"])), ts, "a different command is a different server");
    assert_ne!(client_key("/w", "python", &sv(&["ty", "server"])).1, ts.1);
}

/// Start `cmds` with a fake launcher: names in `failing` fail to start.
/// Returns what started and every attempt, in order.
async fn start_with(lang: &str, cmds: &[&[&str]], failing: &[&str]) -> (Vec<String>, Vec<String>) {
    let attempts = Mutex::new(vec![]);
    let started = start_servers(lang, cmds.iter().map(|c| sv(c)).collect(), |cmd| {
        attempts.lock().unwrap().push(cmd[0].clone());
        let ok = !failing.contains(&cmd[0].as_str());
        async move { ok.then(|| cmd[0].clone()) }
    })
    .await;
    (started, attempts.into_inner().unwrap())
}

#[tokio::test]
async fn python_runs_one_type_checker_beside_ruff() {
    let all: &[&[&str]] = &[&["ty", "server"], &["ruff", "server"], &["pyright-langserver", "--stdio"], &["pylsp"]];
    // ty wins; pyright and pylsp are never started.
    let (started, attempts) = start_with("python", all, &[]).await;
    assert_eq!(started, ["ty", "ruff"]);
    assert_eq!(attempts, ["ty", "ruff"]);
    // ty fails to start: pyright takes over, pylsp still skipped.
    let (started, _) = start_with("python", all, &["ty"]).await;
    assert_eq!(started, ["ruff", "pyright-langserver"]);
    // Only pylsp left.
    let (started, _) = start_with("python", all, &["ty", "pyright-langserver"]).await;
    assert_eq!(started, ["ruff", "pylsp"]);
    // A managed ruff is an absolute path; it is still the linter.
    let (started, _) = start_with("python", &[&["/cache/ruff-0.1/ruff", "server"], &["ty", "server"]], &[]).await;
    assert_eq!(started, ["/cache/ruff-0.1/ruff", "ty"]);
}

#[tokio::test]
async fn other_languages_start_every_command() {
    let (started, _) = start_with("go", &[&["gopls"], &["other"]], &[]).await;
    assert_eq!(started, ["gopls", "other"]);
}

#[test]
fn report_groups_and_caps() {
    let mut diags = vec![];
    for i in 0..22 {
        diags.push(json!({"severity": 2, "message": " dup ", "source": "ruff", "range": {"start": {"line": i, "character": 0}}}));
    }
    diags.push(json!({"severity": 1, "message": "boom", "range": {"start": {"line": 3, "character": 4}}}));
    diags.push(json!({"severity": 3, "message": "info"}));
    let r = format_diagnostics(&diags, Path::new("/w/a.py"), Path::new("/w")).unwrap();
    assert!(r.starts_with("[LSP Diagnostics]\n- a.py:4:5: error: boom (LSP)\n- a.py:1:1, 2:1"));
    assert!(r.ends_with("- …and 3 more in a.py"));
}

/// A fake server: publishes `diags` after `ms` milliseconds (paused time).
fn publish_after(store: &Arc<Mutex<Vec<Value>>>, event: &Arc<Event>, ms: u64, diags: Vec<Value>) {
    let (store, event) = (store.clone(), event.clone());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        *store.lock().unwrap() = diags;
        event.set();
    });
}

async fn check_after(ms: u64, answer: Result<usize, String>) -> Result<usize, String> {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    answer
}

fn error_diag() -> Value {
    json!({"severity": 1, "message": "Type 'string' is not assignable to type 'number'."})
}

/// Waits as the TypeScript path does, returning the result and how long it took.
async fn settle_ts(store: &Arc<Mutex<Vec<Value>>>, event: &Arc<Event>, check: impl std::future::Future<Output = Result<usize, String>>) -> (Vec<Value>, u128) {
    let start = tokio::time::Instant::now();
    let got = await_settled(|| store.lock().unwrap().clone(), event, Some(check), 10.0, 1.0).await;
    (got, start.elapsed().as_millis())
}

#[tokio::test(start_paused = true)]
async fn a_clean_typescript_file_returns_when_the_server_says_it_checked_it() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    // A warm typescript-language-server answers the check before it
    // publishes the empty result.
    publish_after(&store, &event, 360, vec![]);
    let (got, ms) = settle_ts(&store, &event, check_after(30, Ok(0))).await;
    assert!(got.is_empty());
    assert_eq!(ms, 30, "no quiet-period wait after a clean check");
}

#[tokio::test(start_paused = true)]
async fn a_broken_typescript_file_still_reports_its_error() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    // The syntax pass publishes nothing; the type error arrives later.
    publish_after(&store, &event, 100, vec![]);
    publish_after(&store, &event, 650, vec![error_diag()]);
    let (got, ms) = settle_ts(&store, &event, check_after(600, Ok(1))).await;
    assert_eq!(got, vec![error_diag()]);
    assert_eq!(ms, 650);
}

#[tokio::test(start_paused = true)]
async fn a_late_error_on_a_cold_server_is_still_caught() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    // A cold project: the first empty publish comes early, the check takes
    // seconds, and the error is published well past the 1 s quiet period.
    publish_after(&store, &event, 200, vec![]);
    publish_after(&store, &event, 5_200, vec![error_diag()]);
    let (got, _) = settle_ts(&store, &event, check_after(5_100, Ok(1))).await;
    assert_eq!(got, vec![error_diag()]);
}

#[tokio::test(start_paused = true)]
async fn a_server_without_the_check_falls_back_to_the_quiet_period() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    publish_after(&store, &event, 300, vec![]);
    let (got, ms) = settle_ts(&store, &event, check_after(5, Err("Unknown command".into()))).await;
    assert!(got.is_empty());
    assert_eq!(ms, 1_300, "first publish, then 1 s of quiet");
}

#[tokio::test(start_paused = true)]
async fn problems_that_are_never_published_end_at_the_deadline() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    let (got, ms) = settle_ts(&store, &event, check_after(50, Ok(2))).await;
    assert!(got.is_empty());
    assert_eq!(ms, 10_000);
}

#[tokio::test(start_paused = true)]
async fn other_languages_keep_the_quiet_period() {
    let (store, event) = (Arc::new(Mutex::new(vec![])), Arc::new(Event::default()));
    publish_after(&store, &event, 100, vec![]);
    let start = tokio::time::Instant::now();
    let got = await_settled(|| store.lock().unwrap().clone(), &event, None::<std::future::Ready<Result<usize, String>>>, 3.0, 0.25).await;
    assert!(got.is_empty());
    assert_eq!(start.elapsed().as_millis(), 350);
}

#[test]
fn tsserver_responses_count_errors_and_warnings_only() {
    let body = json!({"success": true, "body": [{"category": "error"}, {"category": "warning"}, {"category": "suggestion"}, {"category": "message"}]});
    assert_eq!(ts_problems(&body), Ok(2));
    assert_eq!(ts_problems(&json!({"success": true, "body": []})), Ok(0));
    assert!(ts_problems(&json!({"success": false, "message": "Unknown command"})).is_err());
    assert!(ts_problems(&Value::Null).is_err());
}

/// Against a real `typescript-language-server`, in a throwaway project:
/// `OAD_TS_PROBE=<project>/a.ts cargo test -p appv3-tools --lib real_typescript -- --ignored --nocapture`
/// (the folder needs a `tsconfig.json` and `node_modules/typescript`).
#[tokio::test]
#[ignore]
async fn real_typescript_server_reports_errors_and_skips_the_wait_when_clean() {
    let file = PathBuf::from(std::env::var("OAD_TS_PROBE").expect("OAD_TS_PROBE=<file.ts>"));
    let root = file.parent().unwrap().to_path_buf();
    let clean = std::fs::read_to_string(&file).unwrap();
    let broken = format!("{clean}\nexport const probe: number = \"text\";\n");
    for (label, text, expect_error) in
        [("cold clean", &clean, false), ("warm clean", &clean, false), ("warm broken", &broken, true), ("warm clean", &clean, false), ("warm broken", &broken, true)]
    {
        std::fs::write(&file, text).unwrap();
        let started = std::time::Instant::now();
        let report = check_lsp_diagnostics(&file, &root).await;
        println!("{label}: {} ms, report: {}", started.elapsed().as_millis(), report.as_deref().unwrap_or("none").replace('\n', " | "));
        assert_eq!(report.as_deref().is_some_and(|r| r.contains("not assignable")), expect_error, "{label}");
    }
    std::fs::write(&file, &clean).unwrap();
}
