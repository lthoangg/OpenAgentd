use super::*;

#[test]
fn handles_and_pruning() {
    assert_eq!(parse_instance_handle("explorer#3"), Some(("explorer".into(), 3)));
    assert_eq!(parse_instance_handle("explorer"), None);
    assert_eq!(allocate_instance_handle("L", "explorer"), "explorer#1");
    assert_eq!(allocate_instance_handle("L", "explorer"), "explorer#2");
    assert_eq!(allocate_instance_handle("L", "worker"), "worker#1", "each profile counts on its own");
    let long = "x".repeat(40_000);
    let p = prune_subagent_output(&long, "explorer#1", MAX_SUBAGENT_OUTPUT_CHARS);
    assert!(p.contains("Output truncated: 40000 chars total"));
    // The lead cannot open a subagent's session, so the notice says how
    // to get the rest instead of pointing there.
    assert!(p.contains("team(target='explorer#1', task="), "{p}");
    assert!(!p.contains("session"), "{p}");
    assert_eq!(resolve_instance("L", "nobody").unwrap_err().to_string(), "Member 'nobody' not found. Live instances: None.");
}

/// The lead used to read "Subagent turn failed with error." whatever the
/// cause, so it could not tell a retry from a dead end.
#[test]
fn a_failure_report_names_the_reason_and_whether_retrying_helps() {
    let rate = json!({"message": "The configured LLM provider is rate-limited or quota-exhausted.", "title": "Rate Limit Exceeded", "code": "provider_rate_limit"});
    assert_eq!(
        failure_report("explorer#1", Some(&rate), None),
        "explorer#1 failed: Rate Limit Exceeded: The configured LLM provider is rate-limited or quota-exhausted. Its work so far is kept in its session. \
             Retrying may help: team(target='explorer#1', task='continue'). Or give the task to another profile, or do it yourself."
    );

    let auth =
        json!({"message": "mock:worker rejected the request — authentication failed (HTTP 401).", "title": "Provider Authentication Failed", "code": "provider_auth_failed"});
    let text = failure_report("worker#2", Some(&auth), None);
    assert!(text.starts_with("worker#2 failed: Provider Authentication Failed: mock:worker rejected the request"), "{text}");
    assert!(text.contains("Retrying won't help until its model or provider is fixed."), "{text}");

    // A turn refused before it ran has only the recorded reason.
    let refused = failure_report("worker#3", None, Some("A question is pending."));
    assert_eq!(
            refused,
            "worker#3 failed: A question is pending. Its work so far is kept in its session. Retry it with team(target='worker#3', task='continue'), give the task to another profile, or do it yourself."
        );
    assert!(failure_report("worker#4", None, None).contains("worker#4 failed: its turn failed with an unknown error."));
}

fn retry(status: &str, code: Option<i64>, error_type: Option<&str>) -> ProviderStatus {
    ProviderStatus { status: status.into(), model: Some("mock:worker".into()), status_code: code, error_type: error_type.map(String::from), ..Default::default() }
}

#[test]
fn a_member_that_keeps_failing_to_reach_its_model_alerts_its_lead_once() {
    let start = tokio::time::Instant::now();
    let mut w = StallWatch::default();
    assert_eq!(w.on_retry(&retry("retrying", None, Some("ConnectError")), start), None, "one failed call is not a stall");
    assert_eq!(w.on_retry(&retry("retrying", None, Some("ConnectError")), start + Duration::from_secs(60)), None);
    let notice = w.on_retry(&retry("retrying", None, Some("ConnectError")), start + STALL_NOTICE_AFTER);
    assert_eq!(notice.as_deref(), Some("it has not reached mock:worker for 2 min (ConnectError)"));
    assert_eq!(w.on_retry(&retry("retrying", None, Some("ConnectError")), start + Duration::from_secs(600)), None, "only once per stall");
    assert_eq!(w.on_retry(&retry("switched_credential", Some(429), None), start + Duration::from_secs(601)), None);

    // It recovers, then stalls again: that is a new stall.
    assert!(w.on_progress());
    assert!(!w.on_progress(), "no stall left to clear");
    let later = start + Duration::from_secs(1000);
    assert_eq!(w.on_retry(&retry("retrying", Some(503), None), later), None);
    assert_eq!(w.on_retry(&retry("retrying", Some(503), None), later + STALL_NOTICE_AFTER).as_deref(), Some("it has not reached mock:worker for 2 min (HTTP 503)"));
}

#[test]
fn a_quota_wait_alerts_the_lead_at_once() {
    let mut w = StallWatch::default();
    let wait = ProviderStatus { delay_seconds: Some(3602.0), ..retry("waiting_quota", Some(429), None) };
    let now = tokio::time::Instant::now();
    assert_eq!(w.on_retry(&wait, now).as_deref(), Some("mock:worker is out of quota, and it is waiting 1h 00m for the reset"));
    assert_eq!(w.on_retry(&wait, now + Duration::from_secs(3700)), None);
    assert_eq!(
        stall_notice("worker#1", "mock:worker is out of quota, and it is waiting 1h 00m for the reset"),
        "worker#1 is stalled: mock:worker is out of quota, and it is waiting 1h 00m for the reset. It keeps trying on its own, and its report will follow if it recovers. \
             To go on without it, stop it with team(action='stop', target='worker#1')."
    );
}

/// A member waiting on `ask_lead` keeps its turn open; stopping it must
/// close that turn, or every client keeps showing it running.
#[tokio::test]
async fn stopping_a_member_that_waits_on_its_lead_ends_its_turn() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-stop-waiting";
    let child = uuid::Uuid::now_v7().to_string();
    let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child.clone()), None, pool.clone(), factory, Some(lead.into()));
    let mut inst = SubagentInstance::new("explorer#1", "explorer", lead, &child, session, MemberStatus::WaitingLead);
    inst.pending_lead_question = Some(json!({"question": "Which branch?"}));
    reg().lock().unwrap().live.entry(lead.into()).or_default().insert("explorer#1".into(), inst);
    store().init_turn(&child, true);
    assert!(store().is_running(&child));

    let out = stop_subagent(lead, "explorer#1", &pool).await.unwrap();

    assert_eq!(out["status"], json!("stopped"));
    assert!(!store().is_running(&child), "the waiting member's turn was left open");
    assert!(!subagents_waiting_on_lead().contains(&db::codec::api_uuid(&child)));
    assert_eq!(describe_subagents(lead, &pool).await, "- explorer#1: stopped (send it a task to resume)");
}

#[tokio::test]
async fn the_list_shows_each_members_state_in_spawn_order() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-list";
    assert_eq!(describe_subagents(lead, &pool).await, "No subagents yet.");
    let add = |handle: &str, status: MemberStatus, edit: &dyn Fn(&mut SubagentInstance)| {
        let agent = Agent::new(provider.clone(), handle, "", vec![], None);
        let session = AgentSession::new(agent, Some(format!("{handle}-sid")), None, pool.clone(), factory.clone(), Some(lead.into()));
        let mut inst = SubagentInstance::new(handle, "explorer", lead, &format!("{handle}-sid"), session, status);
        edit(&mut inst);
        let mut r = reg().lock().unwrap();
        r.live.entry(lead.into()).or_default().insert(handle.into(), inst);
        r.order.entry(lead.into()).or_default().push(handle.into());
    };
    add("explorer#2", MemberStatus::Working, &|i| i.stall = Some("it has not reached m for 2 min (HTTP 503)".into()));
    add("explorer#10", MemberStatus::WaitingLead, &|i| i.pending_lead_question = Some(json!({"question": "Which branch?"})));
    add("explorer#3", MemberStatus::Error, &|i| i.last_error = Some("Rate limited.".into()));
    add("explorer#4", MemberStatus::Stopped, &|_| {});
    add("explorer#5", MemberStatus::Completed, &|_| {});

    assert_eq!(
        describe_subagents(lead, &pool).await,
        "- explorer#2: working for 0s, stalled: it has not reached m for 2 min (HTTP 503)\n\
             - explorer#10: waiting for your answer: Which branch?\n\
             - explorer#3: failed: Rate limited.\n\
             - explorer#4: stopped (send it a task to resume)\n\
             - explorer#5: done (report delivered)"
    );
}

/// Only a member whose completed turn's report reached the lead long
/// enough ago may leave memory. The registry is the only place that
/// holds a failed member's error, a waiting one's question and a stopped
/// one's resume state, so those stay loaded.
#[tokio::test]
async fn only_a_member_that_reported_long_enough_ago_may_be_unloaded() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let reported = std::time::Instant::now();
    let member = |status: MemberStatus, reported_at: Option<std::time::Instant>| {
        let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
        let session = AgentSession::new(agent, Some("explorer#1-sid".into()), None, pool.clone(), factory.clone(), Some("lead-unload".into()));
        let mut inst = SubagentInstance::new("explorer#1", "explorer", "lead-unload", "explorer#1-sid", session, status);
        inst.reported_at = reported_at;
        inst
    };
    let due = reported + UNLOAD_FINISHED_AFTER;
    let done = member(MemberStatus::Completed, Some(reported));
    assert!(!done.unload_due(due - Duration::from_secs(1)), "unloaded before the wait passed");
    assert!(done.unload_due(due));
    assert!(!member(MemberStatus::Completed, None).unload_due(due), "its report has not reached the lead");
    for status in [MemberStatus::Working, MemberStatus::WaitingLead, MemberStatus::Error, MemberStatus::Stopped] {
        assert!(!member(status, Some(reported)).unload_due(due), "{status:?}");
    }
    // A turn is running, or a message is on its way in.
    let busy = member(MemberStatus::Completed, Some(reported));
    busy.session.set_state("working");
    assert!(!busy.unload_due(due));
    let receiving = member(MemberStatus::Completed, Some(reported));
    let sender = receiving.session.user_message_lock.lock().await;
    assert!(!receiving.unload_due(due));
    drop(sender);
    assert!(receiving.unload_due(due));
    // New work clears the report time.
    let mut resumed = member(MemberStatus::Completed, Some(reported));
    resumed.start_follow_up();
    assert_eq!(resumed.reported_at, None);
}

/// A member is told the limit the lead's copy is actually cut at, and
/// that it works from the task alone; nothing else told it either.
#[test]
fn team_context_states_the_limit_the_lead_enforces() {
    let text = team_context("explorer#1", "member");

    assert!(text.starts_with("## Team Context\nYou are instance **explorer#1** (role: member)"), "{text}");
    assert!(text.contains("at most 32,000 characters"), "{text}");
    assert_eq!(MAX_SUBAGENT_OUTPUT_CHARS, 32_000, "update the stated limit with the enforced one");
    assert!(text.contains("You see only the task the lead sent"), "{text}");
    assert!(text.contains("`ask_lead`"), "{text}");
}

#[tokio::test]
async fn only_a_running_subagent_keeps_the_lead_working() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-working-subagents";
    let add = |handle: &str, status: MemberStatus, state: &str| {
        let agent = Agent::new(provider.clone(), handle, "", vec![], None);
        let session = AgentSession::new(agent, Some(format!("{handle}-sid")), None, pool.clone(), factory.clone(), Some(lead.into()));
        session.set_state(state);
        let inst = SubagentInstance {
            handle: handle.into(),
            profile_name: "explorer".into(),
            lead_session_id: lead.into(),
            session_id: format!("{handle}-sid"),
            session,
            status,
            last_result: None,
            pending_lead_question: None,
            last_error: None,
            question_delivered: false,
            result_delivered: false,
            pending_tool_call_id: None,
            stall: None,
            working_since: None,
            stopped_by_restart: false,
            reported_at: None,
        };
        reg().lock().unwrap().live.entry(lead.into()).or_default().insert(handle.into(), inst);
    };
    assert!(!has_working_subagents(lead), "no subagents");
    // Done (its report is on its way to the lead), or marked working with no turn left.
    add("explorer#1", MemberStatus::Completed, "idle");
    add("explorer#2", MemberStatus::Working, "idle");
    assert!(!has_working_subagents(lead));
    add("explorer#3", MemberStatus::Working, "working");
    assert!(has_working_subagents(lead));
    assert!(!has_working_subagents("another-lead"));
    assert!(leads_with_working_subagents().contains(lead));
    assert!(has_pending_work(lead));
    assert!(sessions_with_pending_work().contains(lead));
}

/// The web refetches a lead's members as soon as `subagent_spawned`
/// arrives, which is before the member's first turn has started (its
/// workspace snapshot alone can take seconds). Listing it then once
/// settled it as completed for good: the lead left the active list, and
/// the notch called it finished while every member still worked.
#[tokio::test]
async fn listing_a_subagent_before_its_turn_starts_keeps_it_working() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead_row = db::create_session(&pool, db::NewSession { workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
    let lead = db::codec::api_uuid(&lead_row.id);
    let child_row =
        db::create_session(&pool, db::NewSession { parent_session_id: Some(lead.clone()), agent_name: Some("worker#1".into()), workspace: "/tmp".into(), ..Default::default() })
            .await
            .unwrap();
    let child_sid = db::codec::api_uuid(&child_row.id);
    // Registered and marked working, its turn not spawned yet.
    let agent = Agent::new(provider.clone(), "worker#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.clone()));
    let inst = SubagentInstance {
        handle: "worker#1".into(),
        profile_name: "worker".into(),
        lead_session_id: lead.clone(),
        session_id: child_sid,
        session: session.clone(),
        status: MemberStatus::Working,
        last_result: None,
        pending_lead_question: None,
        last_error: None,
        question_delivered: false,
        result_delivered: false,
        pending_tool_call_id: None,
        stall: None,
        working_since: None,
        stopped_by_restart: false,
        reported_at: None,
    };
    reg().lock().unwrap().live.entry(lead.clone()).or_default().insert("worker#1".into(), inst);

    let listed = list_subagents(&lead, &pool).await;
    assert_eq!(listed["subagents"][0]["status"], json!("working"), "{listed}");

    // Its turn starts: the lead still has work coming back to it.
    session.set_state("working");
    assert!(has_working_subagents(&lead), "listing settled the starting member as done");
}

/// A member whose turn never starts never reports, so the failure is
/// recorded where the turn was refused; listed as working, it would stay
/// so for good.
#[tokio::test]
async fn a_follow_up_that_cannot_start_a_turn_marks_the_member_failed() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-follow-up-refused";
    let child = db::create_session(&pool, db::NewSession { workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
    let child_sid = db::codec::api_uuid(&child.id);
    // An open question refuses machine-sent messages.
    db::create_pending_question(&pool, &child_sid, "call_q", &[json!({"question": "Which?"})]).await.unwrap();
    let agent = Agent::new(provider.clone(), "worker#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
    let inst = SubagentInstance {
        handle: "worker#1".into(),
        profile_name: "worker".into(),
        lead_session_id: lead.into(),
        session_id: child_sid,
        session,
        status: MemberStatus::Completed,
        last_result: None,
        pending_lead_question: None,
        last_error: None,
        question_delivered: false,
        result_delivered: false,
        pending_tool_call_id: None,
        stall: None,
        working_since: None,
        stopped_by_restart: false,
        reported_at: None,
    };
    reg().lock().unwrap().live.entry(lead.into()).or_default().insert("worker#1".into(), inst);

    assert!(send_subagent_message(lead, "worker#1", "one more thing", &pool).await.is_err());
    let (status, error) = with_instance(lead, "worker#1", |i| (i.status, i.last_error.clone())).unwrap();
    assert_eq!(status.as_str(), "error");
    assert!(error.is_some_and(|e| !e.is_empty()));
}

#[tokio::test]
async fn a_follow_up_turn_reports_its_own_answer() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-follow-up-report";
    let child = db::create_session(&pool, db::NewSession { title: Some("explorer#1".into()), workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
    let child_sid = db::codec::api_uuid(&child.id);
    let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
    let inst = SubagentInstance {
        handle: "explorer#1".into(),
        profile_name: "explorer".into(),
        lead_session_id: lead.into(),
        session_id: child_sid.clone(),
        session,
        status: MemberStatus::Working,
        last_result: None,
        pending_lead_question: None,
        last_error: None,
        question_delivered: false,
        result_delivered: false,
        pending_tool_call_id: None,
        stall: None,
        working_since: None,
        stopped_by_restart: false,
        reported_at: None,
    };
    reg().lock().unwrap().live.entry(lead.into()).or_default().insert("explorer#1".into(), inst);
    let reported = || find_by_session(lead, &child_sid, |i| i.last_result.clone()).flatten();

    db::save_message(&pool, &child_sid, db::NewMessage::assistant(Some("first report".into()))).await.unwrap();
    on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false, None).await;
    assert_eq!(reported().as_deref(), Some("first report"));

    // The lead sends a follow-up and the subagent answers it in a new turn.
    db::save_message(&pool, &child_sid, db::NewMessage::assistant(Some("second report".into()))).await.unwrap();
    on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false, None).await;
    assert_eq!(reported().as_deref(), Some("second report"));

    // A turn that ends without text says so instead of re-sending an old report.
    db::save_message(&pool, &child_sid, db::NewMessage::assistant(None)).await.unwrap();
    on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "explorer#1", &pool, false, None).await;
    assert_eq!(reported().as_deref(), Some("Subagent 'explorer#1' completed task with no text output."));
}

#[tokio::test]
async fn a_subagent_asking_its_lead_reports_that_it_waits() {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let lead = "lead-waiting-subagent";
    let child_sid = uuid::Uuid::now_v7().to_string();
    let agent = Agent::new(provider.clone(), "explorer#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
    let inst = SubagentInstance {
        handle: "explorer#1".into(),
        profile_name: "explorer".into(),
        lead_session_id: lead.into(),
        session_id: child_sid.clone(),
        session,
        // `ask_lead` sets this before the turn suspends.
        status: MemberStatus::WaitingLead,
        last_result: None,
        pending_lead_question: Some(json!({"question": "Which branch?", "options": []})),
        last_error: None,
        question_delivered: false,
        result_delivered: false,
        pending_tool_call_id: None,
        stall: None,
        working_since: None,
        stopped_by_restart: false,
        reported_at: None,
    };
    reg().lock().unwrap().live.entry(lead.into()).or_default().insert("explorer#1".into(), inst);
    assert!(subagents_waiting_on_lead().contains(&child_sid));

    let mut feed = broadcaster::broadcaster().attach();
    on_subagent_question_asked(lead, &child_sid, &json!({"question": "Which branch?"}), &pool).await;
    let status = loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), feed.next()).await.expect("an event").expect("feed open");
        let data: Value = serde_json::from_str(&ev.data).unwrap();
        if ev.event == "subagent_status" && data["session_id"] == json!(child_sid) {
            break data;
        }
    };
    assert_eq!(status["status"], json!("waiting_lead"));
    assert_eq!(status["lead_session_id"], json!(lead));

    // The lead answers: the subagent works again and no longer waits.
    with_instance(lead, "explorer#1", |i| i.status = MemberStatus::Working);
    assert!(!subagents_waiting_on_lead().contains(&child_sid));
}

/// A registered member of `lead` whose session reads as mid-turn.
async fn busy_member(lead: &str) -> (DbPool, String, Arc<AgentSession>, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let pool = db::create_pool(root.path().join("oad.db")).await.unwrap();
    let provider: Arc<dyn appv3_providers::LlmProvider> = Arc::new(appv3_providers::mock::MockProvider::new(vec![]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let child = db::create_session(&pool, db::NewSession { agent_name: Some("worker#1".into()), workspace: "/tmp".into(), ..Default::default() }).await.unwrap();
    let child_sid = db::codec::api_uuid(&child.id);
    let agent = Agent::new(provider, "worker#1", "", vec![], None);
    let session = AgentSession::new(agent, Some(child_sid.clone()), None, pool.clone(), factory, Some(lead.into()));
    session.set_state("working");
    let inst = SubagentInstance::new("worker#1", "worker", lead, &child_sid, session.clone(), MemberStatus::Working);
    let mut r = reg().lock().unwrap();
    r.live.entry(lead.into()).or_default().insert("worker#1".into(), inst);
    r.order.entry(lead.into()).or_default().push("worker#1".into());
    drop(r);
    (pool, child_sid, session, root)
}

/// A follow-up queued while the member's turn ends is started by that
/// turn's last look at the queue, so the member is still working. The
/// turn's close used to settle it as completed, and the follow-up's turn
/// then ran listed as done.
#[tokio::test]
async fn a_follow_up_queued_before_the_turn_closes_keeps_the_member_working() {
    let lead = "lead-follow-up-before-close";
    let (pool, child_sid, _session, _root) = busy_member(lead).await;
    db::save_queued_user_message(&pool, &child_sid, "[Lead]: also run the tests", Some(from_lead_extra(lead))).await.unwrap();

    on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "worker#1", &pool, false, None).await;

    assert_eq!(with_instance(lead, "worker#1", |i| i.status().as_str()), Some("working"));
    assert_eq!(with_instance(lead, "worker#1", |i| i.last_result.clone()).flatten().as_deref(), Some("Subagent 'worker#1' completed task with no text output."));
}

/// The close looks at the queue only once it holds the member's senders'
/// lock, so a row a sender queues while holding it is seen. Unlocked, the
/// close looked first and settled the member as completed while the
/// turn's last look started the follow-up.
#[tokio::test]
async fn the_close_looks_at_the_queue_only_under_the_senders_lock() {
    let lead = "lead-close-under-senders-lock";
    let (pool, child_sid, session, _root) = busy_member(lead).await;
    let sender = session.user_message_lock.lock().await;
    let mut close = std::pin::pin!(on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "worker#1", &pool, false, None));
    assert!(futures::poll!(close.as_mut()).is_pending(), "the close finished while a sender held the lock");
    db::save_queued_user_message(&pool, &child_sid, "[Lead]: also run the tests", Some(from_lead_extra(lead))).await.unwrap();
    drop(sender);
    close.await;

    assert_eq!(with_instance(lead, "worker#1", |i| i.status().as_str()), Some("working"));
}

/// The lead's follow-up and the member's closing turn wait on the
/// member's senders' lock in either order. Polling each once parks it on
/// the held lock, which takes waiters first come, first served, so the
/// order is fixed. Either way the member ends up working: the send used
/// to mark it before taking the lock, and the close used to settle it
/// without the lock, so each could overwrite the follow-up.
#[tokio::test]
async fn a_follow_up_racing_the_turns_close_keeps_the_member_working() {
    for (lead, close_first) in [("lead-follow-up-close-first", true), ("lead-follow-up-send-first", false)] {
        let (pool, child_sid, session, _root) = busy_member(lead).await;
        let held = session.user_message_lock.lock().await;
        let mut close = std::pin::pin!(on_subagent_turn_completed(lead, &child_sid, "completed", "/tmp", "worker#1", &pool, false, None));
        let mut send = std::pin::pin!(send_subagent_message(lead, "worker#1", "also run the tests", &pool));
        if close_first {
            assert!(futures::poll!(close.as_mut()).is_pending(), "{lead}");
            assert!(futures::poll!(send.as_mut()).is_pending(), "{lead}");
        } else {
            assert!(futures::poll!(send.as_mut()).is_pending(), "{lead}");
            assert!(futures::poll!(close.as_mut()).is_pending(), "{lead}");
        }
        drop(held);
        let ((), out) = tokio::join!(close, send);

        assert_eq!(out.unwrap()["queued"], json!(true), "{lead}");
        assert_eq!(with_instance(lead, "worker#1", |i| i.status().as_str()), Some("working"), "{lead}");
    }
}

/// The registry's statuses are the wire strings clients already read.
#[test]
fn member_statuses_keep_their_wire_strings_and_turn_end_rules() {
    use MemberStatus::*;
    let wire: Vec<&str> = [Working, WaitingLead, Completed, Error, Stopped].iter().map(|s| s.as_str()).collect();
    assert_eq!(wire, ["working", "waiting_lead", "completed", "error", "stopped"]);
    assert_eq!(UNREGISTERED_MEMBER_STATUS.as_str(), "completed");

    assert_eq!(MemberStatus::turn_end("completed", false), Completed);
    assert_eq!(MemberStatus::turn_end("error", false), Error);
    // Cancelled wins over how the turn's status reads.
    assert_eq!(MemberStatus::turn_end("completed", true), Stopped);
    assert_eq!(MemberStatus::turn_end("error", true), Stopped);
    assert!(Completed.reports() && Error.reports() && !Stopped.reports());

    assert_eq!(Completed.after_turn(true), Working);
    assert_eq!(Completed.after_turn(false), Completed);
    assert_eq!(Error.after_turn(true), Error);
    assert_eq!(Stopped.after_turn(true), Stopped);

    assert!(Working.follow_up_runs_next() && Completed.follow_up_runs_next());
    assert!(!Error.follow_up_runs_next() && !Stopped.follow_up_runs_next() && !WaitingLead.follow_up_runs_next());

    assert!(Working.is_active() && WaitingLead.is_active());
    assert!(!Completed.is_active() && !Error.is_active() && !Stopped.is_active());
    assert!(Working.may_still_run() && WaitingLead.may_still_run() && Stopped.may_still_run());
    assert!(!Completed.may_still_run() && !Error.may_still_run());
}

/// A follow-up queued behind a turn that fails or is stopped does not
/// start (the turn's end does not read the queue), so the turn's own end
/// is what the member reads as.
#[tokio::test]
async fn a_follow_up_behind_a_failed_or_stopped_turn_leaves_its_end() {
    for (lead, status, cancelled, expect) in [("lead-follow-up-failed", "error", false, "error"), ("lead-follow-up-stopped", "completed", true, "stopped")] {
        let (pool, child_sid, _session, _root) = busy_member(lead).await;
        db::save_queued_user_message(&pool, &child_sid, "[Lead]: also run the tests", Some(from_lead_extra(lead))).await.unwrap();
        on_subagent_turn_completed(lead, &child_sid, status, "/tmp", "worker#1", &pool, cancelled, None).await;
        assert_eq!(with_instance(lead, "worker#1", |i| i.status().as_str()), Some(expect), "{lead}");
    }
}
