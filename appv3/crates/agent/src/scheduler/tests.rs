use super::*;

/// A timer sleeps on the monotonic clock, which can run ahead of the
/// wall clock: woken a little before its slot, the next slot computed
/// from that time was the same slot again, so the task ran twice.
#[tokio::test(start_paused = true)]
async fn the_timer_does_not_wake_before_its_slot_on_the_wall_clock() {
    let base = Utc::now();
    let start = tokio::time::Instant::now();
    // The wall clock gains 99ms for every 100ms slept.
    let wall = move || base + chrono::Duration::milliseconds((start.elapsed().as_millis() as i64) * 99 / 100);
    let slot = base + chrono::Duration::seconds(10);
    wait_until(slot, wall).await;
    assert!(wall() >= slot, "woke {}ms before its slot", (slot - wall()).num_milliseconds());
}

#[test]
fn slugify_matches_v2() {
    assert_eq!(slugify("Check Build Status!"), "check-build-status");
    assert_eq!(slugify("Café déjà vu"), "cafe-deja-vu");
    assert_eq!(slugify("..__Hello__.."), "hello");
    let mut c = TaskCreate { name: "x".into(), workspace: "/tmp".into(), schedule_type: "every".into(), timezone: "UTC".into(), prompt: "p".into(), ..Default::default() };
    assert_eq!(c.validate().unwrap_err()[0].1, "Value error, every_seconds is required for schedule_type='every'");
    assert!(py_fromisoformat("2026-09-10T15:00:00Z").is_ok());
    assert_eq!(py_fromisoformat("2026-09-10 15:00").unwrap().1, None);
}

/// Strict-schema models fill every field, sending `""` for the unused
/// ones; those count as unset, not as a conflicting schedule.
#[tokio::test]
async fn schedule_tool_create_and_update() {
    let dir = tempfile::tempdir().unwrap().keep();
    init(appv3_db::create_pool(dir.join("t.db")).await.unwrap());
    let ctx = ToolContext {
        session_id: None,
        agent_name: "code".into(),
        tool_call_id: "c1".into(),
        denied: std::sync::Arc::new(appv3_tools::DeniedPaths::with(&dir, None, Some(vec![]), Some(vec![]))),
        workspace: Some(dir.to_string_lossy().to_string()),
        output: None,
        metadata: Default::default(),
        messages: None,
    };
    let args = serde_json::json!({
        "action": "create", "name": "check-deploy", "schedule_type": "every",
        "at_datetime": "", "every_seconds": 90, "cron_expression": "", "timezone": "",
        "prompt": "x", "session_id": "", "max_runs": 2, "enabled": false, "slug": ""
    });
    let out = match ScheduleTaskTool.run(&ctx, args).await {
        Ok(ToolOutput::Text(t)) => t,
        other => panic!("unexpected: {other:?}"),
    };
    assert!(out.starts_with("Scheduled task created."), "{out}");
    assert!(out.contains("schedule    : every"), "{out}");

    // ── update ── (same test: the scheduler is a process-wide singleton)
    async fn run(ctx: &ToolContext, args: serde_json::Value) -> String {
        match ScheduleTaskTool.run(ctx, args).await {
            Ok(ToolOutput::Text(t)) => t,
            Err(e) => format!("ERR {e:?}"),
            other => panic!("unexpected: {other:?}"),
        }
    }
    // Blank fields from strict-schema models are "unchanged"; `enabled` stays false.
    let out = run(
        &ctx,
        serde_json::json!({
            "action": "update", "slug": "check-deploy", "name": "", "schedule_type": "", "at_datetime": "",
            "every_seconds": 120, "cron_expression": "", "timezone": "", "prompt": "", "session_id": "", "max_runs": null
        }),
    )
    .await;
    assert!(out.starts_with("Task 'check-deploy' updated."), "{out}");
    assert!(out.contains("slug=check-deploy") && out.contains("schedule=every 120s"), "{out}");
    assert!(out.contains("status=paused") && out.contains("runs=0/2"), "{out}");

    // The run count survives later updates.
    let s = scheduler();
    let mut t = s.get_task("check-deploy").await.unwrap().unwrap();
    t.run_count = 1;
    s.update(t).await.unwrap();

    // Resume and pause through `enabled`.
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "enabled": true})).await;
    assert!(out.contains("status=enabled/pending") && out.contains("runs=1/2") && out.contains("next="), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "enabled": false})).await;
    assert!(out.contains("status=paused"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "enabled": true, "prompt": "y", "max_runs": 5})).await;
    assert!(out.contains("status=enabled") && out.contains("runs=1/5") && out.contains("schedule=every 120s"), "{out}");
    assert_eq!(s.get_task("check-deploy").await.unwrap().unwrap().prompt, "y");

    // A field that does not fit the task's schedule type is refused, nothing changes.
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "cron_expression": "0 9 * * *"})).await;
    assert!(out.starts_with("Error: cron_expression does not apply"), "{out}");
    assert_eq!(s.get_task("check-deploy").await.unwrap().unwrap().every_seconds, Some(120));

    // Switching to cron needs its field and keeps slug and run count.
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "schedule_type": "cron"})).await;
    assert!(out.contains("cron_expression is required"), "{out}");
    let out = run(
        &ctx,
        serde_json::json!({
            "action": "update", "slug": "check-deploy", "schedule_type": "cron",
            "cron_expression": "0 9 * * 1-5", "timezone": "Europe/Paris"
        }),
    )
    .await;
    assert!(out.contains("schedule=cron '0 9 * * 1-5' (Europe/Paris)") && out.contains("runs=1/5"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "cron_expression": "not cron"})).await;
    assert!(out.starts_with("Error: invalid task configuration"), "{out}");

    // Unknown slug, empty update, rename, unknown timezone.
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "nope", "prompt": "z"})).await;
    assert_eq!(out, "Error: no task with slug 'nope'.");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "prompt": "", "timezone": ""})).await;
    assert!(out.starts_with("ERR") && out.contains("at least one field to change"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "name": "other"})).await;
    assert!(out.starts_with("ERR") && out.contains("name cannot be changed"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "check-deploy", "timezone": "Mars/Base"})).await;
    assert_eq!(out, "Error: unknown timezone 'Mars/Base'.");

    // A naive `at_datetime` is read in the task's own timezone unless one is given.
    let out = run(
        &ctx,
        serde_json::json!({
            "action": "create", "name": "once", "schedule_type": "at",
            "at_datetime": "2099-01-01T09:00:00", "timezone": "Europe/Paris", "prompt": "x"
        }),
    )
    .await;
    assert!(out.contains("2099-01-01 08:00:00"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "once", "at_datetime": "2099-06-01T09:00:00"})).await;
    assert!(out.contains("next=2099-06-01 07:00:00"), "{out}");
    let out = run(&ctx, serde_json::json!({"action": "update", "slug": "once", "at_datetime": "2099-06-01T09:00:00", "timezone": "UTC"})).await;
    assert!(out.contains("next=2099-06-01 09:00:00"), "{out}");
}

/// A scheduler of its own (not the process-wide one), on a fresh database.
async fn own_scheduler() -> (Arc<TaskScheduler>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let pool = appv3_db::create_pool(dir.path().join("t.db")).await.unwrap();
    (Arc::new(TaskScheduler { pool, st: Mutex::new(State::default()), state_lock: tokio::sync::Mutex::new(()) }), dir)
}

/// An hourly task with no workspace: a fire fails before it dispatches,
/// so no agent or session is needed to drive the fire path.
async fn hourly_task(s: &TaskScheduler, slug: &str) -> ScheduledTask {
    let now = codec::now_db();
    let t = ScheduledTask {
        id: String::new(),
        name: slug.into(),
        schedule_type: "every".into(),
        at_datetime: None,
        every_seconds: Some(3600),
        cron_expression: None,
        timezone: "UTC".into(),
        prompt: "p".into(),
        session_id: None,
        enabled: true,
        status: "pending".into(),
        run_count: 0,
        last_run_at: None,
        last_error: None,
        next_fire_at: None,
        created_at: now.clone(),
        updated_at: now,
        workspace: String::new(),
        max_runs: None,
        slug: slug.into(),
    };
    db::insert_task(&s.pool, &t).await.unwrap()
}

/// Characterization: a fire that fails before dispatch still counts a
/// run and records the error, so the task shows it failed.
#[tokio::test]
async fn a_fire_that_fails_before_dispatch_counts_a_failed_run() {
    let (s, _dir) = own_scheduler().await;
    let t = hourly_task(&s, "no-workspace").await;

    s.clone().fire_task(t.clone(), Some(0)).await;

    let fresh = db::get_task(&s.pool, &t.id).await.unwrap().unwrap();
    assert_eq!((fresh.status.as_str(), fresh.run_count), ("failed", 1));
    assert_eq!(fresh.last_error.as_deref(), Some("Task has no workspace configured."));
    assert!(fresh.enabled && fresh.next_fire_at.is_some(), "a failed run keeps the schedule");
}

/// A task whose last allowed run fails stops there instead of firing past
/// `max_runs` at every later slot.
#[tokio::test]
async fn a_failed_last_allowed_run_stops_the_task() {
    let (s, _dir) = own_scheduler().await;
    let mut t = hourly_task(&s, "last-run-fails").await;
    t.max_runs = Some(1);
    let t = db::save_task(&s.pool, &t).await.unwrap();

    s.clone().fire_task(t.clone(), Some(0)).await;

    let fresh = db::get_task(&s.pool, &t.id).await.unwrap().unwrap();
    assert_eq!((fresh.status.as_str(), fresh.run_count), ("failed", 1));
    assert!(!fresh.enabled && fresh.next_fire_at.is_none(), "a task fired past max_runs after its last run failed");
}

/// An edit that lands after a fire passed its version check, but before
/// it marked the task running, supersedes that fire. The fire used to mark
/// the edited task running anyway and then return as stale, so the task
/// read "running" until its next fire.
#[tokio::test]
async fn an_edit_landing_while_a_fire_waits_leaves_the_task_pending() {
    let (s, _dir) = own_scheduler().await;
    let t = hourly_task(&s, "edited").await;
    let held = s.state_lock.lock().await;
    let fire = tokio::spawn(s.clone().fire_task(t.clone(), Some(0)));
    // The fire passed its version check and now waits for the lock.
    while !s.st.lock().unwrap().firing.contains(&t.id) {
        tokio::task::yield_now().await;
    }
    let mut edited = db::get_task(&s.pool, &t.id).await.unwrap().unwrap();
    edited.prompt = "edited".into();
    s.update_locked(edited).await.unwrap();
    drop(held);
    fire.await.unwrap();
    s.stop();

    let fresh = db::get_task(&s.pool, &t.id).await.unwrap().unwrap();
    assert_eq!((fresh.status.as_str(), fresh.run_count, fresh.last_error.as_deref()), ("pending", 0, None), "a superseded fire changed the task");
}

fn task(schedule_type: &str, status: &str, enabled: bool, run_count: i64, max_runs: Option<i64>) -> ScheduledTask {
    ScheduledTask {
        id: "t".into(),
        name: "t".into(),
        schedule_type: schedule_type.into(),
        at_datetime: (schedule_type == "at").then(|| codec::dt_db(&(Utc::now() - chrono::Duration::minutes(1)))),
        every_seconds: (schedule_type == "every").then_some(60),
        cron_expression: None,
        timezone: "UTC".into(),
        prompt: "p".into(),
        session_id: None,
        enabled,
        status: status.into(),
        run_count,
        last_run_at: None,
        last_error: None,
        next_fire_at: None,
        created_at: String::new(),
        updated_at: String::new(),
        workspace: "/w".into(),
        max_runs,
        slug: "t".into(),
    }
}

/// Each counted run's next state, by schedule and outcome.
#[test]
fn a_counted_run_sets_the_tasks_next_state() {
    let now = Utc::now();
    let run = |mut t: ScheduledTask, error: Option<&str>| {
        record_run(&mut t, error.map(String::from), now);
        (t.status.clone(), t.enabled, t.run_count, t.next_fire_at.is_some(), t.last_error.clone())
    };
    assert_eq!(run(task("every", "running", true, 0, None), None), ("pending".into(), true, 1, true, None));
    assert_eq!(run(task("every", "running", true, 1, Some(2)), None), ("completed".into(), false, 2, false, None));
    // A failed run keeps its schedule while runs remain.
    assert_eq!(run(task("every", "running", true, 0, Some(2)), Some("boom")), ("failed".into(), true, 1, true, Some("boom".into())));
    // A failure on the last allowed run stops the task: it never fires past
    // `max_runs`. Run now or Resume retries it.
    assert_eq!(run(task("every", "running", true, 1, Some(2)), Some("boom")), ("failed".into(), false, 2, false, Some("boom".into())));
    assert_eq!(run(task("at", "running", true, 0, None), None).0, "completed");
    // Paused while it ran: counted, but the pause stands.
    assert_eq!(run(task("every", "paused", false, 0, None), None), ("paused".into(), false, 1, false, None));
}

#[test]
fn only_a_current_fire_that_ran_or_failed_counts() {
    let failed = |dispatch_attempted| FireOutcome::Failed { error: "e".into(), dispatch_attempted };
    assert_eq!(FireOutcome::Dispatched.settle(false).counted_run(), Some(None), "a dispatched prompt counts after any change");
    assert_eq!(failed(true).settle(false).counted_run(), Some(Some("e".into())));
    assert_eq!(failed(false).settle(true).counted_run(), Some(Some("e".into())));
    assert_eq!(failed(false).settle(false), FireOutcome::Superseded);
    assert_eq!(FireOutcome::Superseded.settle(true).counted_run(), None);
    assert_eq!(FireOutcome::Skipped(SkipReason::ActiveTurn).settle(true).counted_run(), None);
    assert_eq!(FireOutcome::Skipped(SkipReason::PendingQuestion).settle(true).counted_run(), None);
}
