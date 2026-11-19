//! Tests of `island.rs`: kept beside it so the module stays readable.

use super::*;

fn row(id: &str, title: Option<&str>, running: bool, needs_input: bool) -> SessionRow {
    SessionRow {
        id: id.into(),
        title: title.map(Into::into),
        workspace: Some("/Users/me/code/openagentd".into()),
        running,
        needs_input,
        background_work: false,
        parent_session_id: None,
        goal_status: None,
        goal_turns_used: None,
        goal_max_turns: None,
        sent_from: None,
    }
}

fn session(id: &str, state: SessionState) -> IslandSession {
    IslandSession {
        id: id.into(),
        title: format!("T{id}"),
        workspace: None,
        state,
        question: None,
        question_id: None,
        server: None,
        server_id: None,
        goal: None,
        sent_from: None,
        finished_seq: None,
    }
}

const REMOTE: &str = "http://192.168.1.30:4082";
const REMOTE_NAME: &str = "LAN server";

fn remote() -> ServerId {
    ServerId::External(REMOTE.into())
}

#[test]
fn session_menus_only_offer_dismiss_for_finished_work() {
    for state in [SessionState::Running, SessionState::NeedsInput, SessionState::Done, SessionState::Failed] {
        let item = session("a", state);
        let actions = menu_actions(&item);
        assert_eq!(actions[..2], [SessionAction::Open, SessionAction::NewWindow]);
        assert_eq!(actions.contains(&SessionAction::Dismiss), matches!(state, SessionState::Done | SessionState::Failed));
    }
}

// Reading a session in one window tells the others, never the overlays
// (they hear through their own events) nor the window that read it.
#[test]
fn a_read_reaches_the_other_app_windows_only() {
    let labels = || ["main", "window-2", ISLAND_WINDOW, crate::pet::PET_WINDOW, crate::tray_popup::TRAY_POPUP_WINDOW].map(String::from);
    assert_eq!(read_recipients(labels(), Some("main")), ["window-2"]);
    let mut all = read_recipients(labels(), None);
    all.sort();
    assert_eq!(all, ["main", "window-2"]);
}

#[test]
fn menu_actions_revalidate_the_target_and_keep_its_server() {
    let mut item = session("r", SessionState::Done);
    item.server_id = Some(remote());
    let mut status = IslandStatus { unread: vec![item], ..IslandStatus::default() };
    for action in [SessionAction::Open, SessionAction::NewWindow, SessionAction::Dismiss] {
        assert_eq!(action_session(&status, "r", action).unwrap().server_id, Some(remote()));
    }
    assert!(action_session(&status, "unknown", SessionAction::Open).is_err());
    status.unread.clear();
    assert!(action_session(&status, "r", SessionAction::NewWindow).is_err());
    let mut running = session("r", SessionState::Running);
    running.server_id = Some(remote());
    status.sessions.push(running);
    assert!(action_session(&status, "r", SessionAction::Dismiss).is_err());
}

#[test]
fn menu_actions_cannot_open_sessions_without_a_known_server() {
    let status = IslandStatus { sessions: vec![session("a", SessionState::Running)], ..IslandStatus::default() };
    assert!(action_session(&status, "a", SessionAction::Open).is_err());
    assert!(action_session(&status, "a", SessionAction::NewWindow).is_err());
}

#[test]
fn menu_events_are_scoped_to_the_island_and_encode_the_selected_session() {
    for action in [SessionAction::Open, SessionAction::NewWindow, SessionAction::Dismiss] {
        let id = format!("island:{}:a-b-c", action.key());
        assert_eq!(menu_selection(&id), Some((action, "a-b-c")));
    }
    assert_eq!(menu_selection("settings"), None);
    assert_eq!(menu_selection("island:delete:a"), None);
    assert_eq!(menu_selection("island:open"), None);
}

fn ids(sessions: &[IslandSession]) -> Vec<&str> {
    sessions.iter().map(|s| s.id.as_str()).collect()
}

/// The builtin and a remote server both followed, with these active lists.
fn two_servers(on_builtin: &[&str], on_remote: &[&str]) -> Feeds {
    let mut feeds = Feeds::default();
    feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
    feeds.join(&remote(), REMOTE_NAME.into());
    let running = |list: &[&str]| -> Vec<IslandSession> { list.iter().map(|id| session(id, SessionState::Running)).collect() };
    feeds.update(&ServerId::Bundled, running(on_builtin), &HashMap::new(), &HashMap::new(), None, true);
    feeds.update(&remote(), running(on_remote), &HashMap::new(), &HashMap::new(), None, true);
    feeds
}

// The notch used to follow one server at a time, so sessions running or
// waiting on you on any other server never showed.
#[test]
fn sessions_from_every_followed_server_are_shown_and_named() {
    let mut feeds = two_servers(&["a", "b"], &["r"]);
    let mut asked = session("q", SessionState::NeedsInput);
    asked.question = Some("Which branch?".into());
    feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running), asked], &HashMap::new(), &HashMap::new(), None, true);

    let (sessions, _) = feeds.lists();
    assert_eq!(ids(&sessions), ["q", "a", "r"], "waiting first, across servers");
    let servers: Vec<Option<&str>> = sessions.iter().map(|s| s.server.as_deref()).collect();
    assert_eq!(servers, [Some(BUILTIN_NAME), Some(BUILTIN_NAME), Some(REMOTE_NAME)]);
}

#[test]
fn one_server_needs_no_name_on_its_rows() {
    let mut feeds = Feeds::default();
    feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
    feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(feeds.lists().0[0].server, None);
}

// A saved server watched in the background but switched off (or away)
// must not make the builtin's rows carry a name.
#[test]
fn an_unreachable_server_does_not_force_names_on_the_others_rows() {
    let mut feeds = Feeds::default();
    feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
    feeds.join(&remote(), REMOTE_NAME.into());
    feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(feeds.lists().0[0].server, None, "the remote never connected");

    feeds.update(&remote(), vec![session("r", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(feeds.lists().0[0].server.as_deref(), Some(BUILTIN_NAME), "both connected");

    assert!(feeds.clear_sessions(&remote()));
    assert!(feeds.set_watch(&remote(), WatchState::Reconnecting));
    assert_eq!(feeds.lists().0[0].server, None, "only the builtin is in play again");
}

#[test]
fn watch_states_follow_the_connection_and_a_list_means_connected() {
    let mut feeds = Feeds::default();
    feeds.join(&remote(), REMOTE_NAME.into());
    assert_eq!(feeds.watch_states(), [(remote(), WatchState::Connecting)]);
    assert!(feeds.set_watch(&remote(), WatchState::KeyRejected));
    assert!(!feeds.set_watch(&remote(), WatchState::KeyRejected), "no change");
    assert!(feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true), "becoming connected is a change");
    assert_eq!(feeds.watch_states(), [(remote(), WatchState::Connected)]);
    assert!(!feeds.set_watch(&ServerId::Bundled, WatchState::Reconnecting), "not followed");
    assert_eq!(serde_json::to_value(WatchState::KeyRejected).unwrap(), "key_rejected");
}

#[test]
fn a_rename_updates_the_label_the_rows_carry() {
    let mut feeds = two_servers(&["a"], &["r"]);
    assert!(feeds.rename(&remote(), "Renamed"));
    assert!(!feeds.rename(&remote(), "Renamed"));
    assert_eq!(feeds.lists().0[1].server.as_deref(), Some("Renamed"));
}

#[test]
fn a_key_rejection_is_told_apart_from_other_failures() {
    let rejected: anyhow::Error = AuthRejected(401).into();
    assert!(rejected.downcast_ref::<AuthRejected>().is_some());
    assert!(rejected.to_string().contains("401"));
    let other = anyhow::anyhow!("event stream closed");
    assert!(other.downcast_ref::<AuthRejected>().is_none());
}

// Switching the followed server used to diff the old server's list
// against the new one's: every session still running there turned Done.
#[test]
fn a_server_dropping_out_reports_nothing_as_finished() {
    let mut feeds = two_servers(&["a"], &["r"]);
    assert!(feeds.forget(&remote()));
    let (sessions, unread) = feeds.lists();
    assert_eq!(ids(&sessions), ["a"]);
    assert!(unread.is_empty());
}

// Following another server used to wipe the previous server's unread rows.
#[test]
fn unread_survives_activity_on_another_server() {
    let mut feeds = two_servers(&["a"], &["r"]);
    assert!(feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true));
    assert_eq!(ids(&feeds.lists().1), ["r"]);

    feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running), session("b", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    let (_, unread) = feeds.lists();
    assert_eq!(ids(&unread), ["r"]);
    assert_eq!(unread[0].server.as_deref(), Some(REMOTE_NAME));
    assert_eq!(unread[0].server_id, Some(remote()), "a click opens it on its own server");
}

#[test]
fn a_server_that_cannot_be_reached_empties_its_list_but_keeps_unread() {
    let mut feeds = two_servers(&["a"], &["r", "s"]);
    feeds.update(&remote(), vec![session("s", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert!(feeds.clear_sessions(&remote()));
    let (sessions, unread) = feeds.lists();
    assert_eq!(ids(&sessions), ["a"]);
    assert_eq!(ids(&unread), ["r"], "s did not finish: the server went away");
    assert!(!feeds.clear_sessions(&remote()), "already empty");
}

#[test]
fn a_forgotten_server_takes_its_unread_rows_with_it() {
    let mut feeds = two_servers(&["a"], &["r"]);
    feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true);
    feeds.update(&ServerId::Bundled, vec![], &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(ids(&feeds.lists().1), ["a", "r"]);
    feeds.forget(&remote());
    assert_eq!(ids(&feeds.lists().1), ["a"]);
}

#[test]
fn a_list_from_a_server_no_longer_followed_is_ignored() {
    let mut feeds = two_servers(&["a"], &[]);
    feeds.forget(&remote());
    assert!(!feeds.update(&remote(), vec![session("late", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true));
    assert_eq!(ids(&feeds.lists().0), ["a"]);
}

#[test]
fn the_same_session_seen_through_two_urls_is_listed_once() {
    let lan = ServerId::External("http://192.168.1.40:4082".into());
    let mut feeds = Feeds::default();
    feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
    feeds.join(&lan, "This Mac over LAN".into());
    feeds.update(&ServerId::Bundled, vec![session("a", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    feeds.update(&lan, vec![session("A", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(ids(&feeds.lists().0), ["a"]);
}

#[test]
fn a_finish_keeps_its_outcome_and_respects_show_finished() {
    let mut feeds = two_servers(&[], &["r", "s"]);
    let statuses = HashMap::from([(id_key("r"), "error".to_string())]);
    feeds.update(&remote(), vec![session("s", SessionState::Running)], &statuses, &HashMap::new(), None, true);
    assert_eq!(feeds.lists().1[0].state, SessionState::Failed);

    feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, false);
    assert_eq!(ids(&feeds.lists().1), ["r"], "s finished while finished sessions are hidden");
}

fn event(name: &str, data: serde_json::Value) -> SseEvent {
    SseEvent { event: name.into(), data: data.to_string() }
}

#[test]
fn waiting_sessions_come_first_and_idle_or_child_rows_are_dropped() {
    let mut child = row("c", Some("child"), true, false);
    child.parent_session_id = Some("a".into());
    let rows = vec![
        row("a", Some("Refactor"), true, false),
        row("b", Some("Ask"), true, true),
        row("idle", Some("Idle"), false, false),
        child,
        row("d", Some("Docs"), true, false),
    ];
    let sessions = active_sessions(rows, &HashMap::new(), None);
    let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["b", "a", "d"]);
    assert_eq!(sessions[0].state, SessionState::NeedsInput);
    assert_eq!(sessions[1].workspace.as_deref(), Some("openagentd"));
}

#[test]
fn a_lead_waiting_on_its_subagents_is_still_working() {
    let mut waiting = row("a", Some("Delegating"), false, false);
    waiting.background_work = true;
    let sessions = active_sessions(vec![waiting], &HashMap::new(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].state, SessionState::Running);

    // Its turn completed, but it stays in the list: not finished, not unread.
    let mut memo = FeedMemo::default();
    let done = serde_json::json!({"session_id": "a", "status": "completed"});
    assert!(memo.note(&event("session_turn_completed", done)));
    assert!(newly_finished(&sessions, &sessions, &memo.statuses, &memo.goals).is_empty());
}

#[test]
fn an_older_backend_without_background_work_still_parses() {
    let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "running": true}]}"#).unwrap();
    assert!(!page.data[0].background_work);
    let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "background_work": true}]}"#).unwrap();
    assert!(page.data[0].background_work);
}

#[test]
fn a_row_carries_no_account_since_the_notch_draws_none() {
    let page: SessionPage =
        serde_json::from_str(r#"{"data": [{"id": "a", "running": true, "credential_label": "Work"}]}"#).unwrap();
    let sessions = active_sessions(page.data, &HashMap::new(), None);
    let wire = serde_json::to_value(&sessions[0]).unwrap();
    assert_eq!(wire["id"], "a", "a pinned session still parses");
    assert!(wire.get("account").is_none(), "{wire}");
}

#[test]
fn a_blank_title_reads_untitled_and_the_question_follows_the_session() {
    let asked = Asked { text: Some("Keep the old format?".into()), id: Some("q-1".into()) };
    let questions = HashMap::from([(id_key("AB-CD"), asked)]);
    let sessions = active_sessions(vec![row("ab-cd", Some("  "), false, true)], &questions, None);
    assert_eq!(sessions[0].title, "Untitled session");
    assert_eq!(sessions[0].question.as_deref(), Some("Keep the old format?"));
    assert_eq!(sessions[0].question_id.as_deref(), Some("q-1"));

    // A session that no longer waits shows no question, whatever the memo holds.
    let running = active_sessions(vec![row("ab-cd", Some("T"), true, false)], &questions, None);
    assert_eq!((running[0].question.as_deref(), running[0].question_id.as_deref()), (None, None));
}

#[test]
fn a_session_in_the_chat_workspace_is_labelled_chat() {
    let mut chat = row("a", Some("Hi"), true, false);
    chat.workspace = Some("/Users/me/".into());
    let mut project = row("b", Some("Code"), true, false);
    project.workspace = Some("/Users/me/code/web".into());
    let sessions = active_sessions(vec![chat, project], &HashMap::new(), Some("/Users/me"));
    assert_eq!(sessions[0].workspace.as_deref(), Some("Chat"));
    assert_eq!(sessions[1].workspace.as_deref(), Some("web"));
}

#[test]
fn a_session_that_leaves_the_list_is_finished_with_its_outcome() {
    let mut asked = session("b", SessionState::NeedsInput);
    asked.question = Some("Which branch?".into());
    let previous = [session("a", SessionState::Running), asked, session("c", SessionState::Running)];
    let statuses = HashMap::from([(id_key("b"), "error".to_string())]);
    let finished = newly_finished(&previous, &previous[2..], &statuses, &HashMap::new());
    let got: Vec<(&str, SessionState)> = finished.iter().map(|s| (s.id.as_str(), s.state)).collect();
    assert_eq!(got, [("a", SessionState::Done), ("b", SessionState::Failed)]);
    assert_eq!(finished[1].question, None);
}

#[test]
fn stopped_and_idle_compaction_turns_are_not_finished() {
    let previous = [session("a", SessionState::Running), session("b", SessionState::Running)];
    let statuses = HashMap::from([
        (id_key("a"), "stopped".to_string()),
        (id_key("b"), IDLE_COMPACTION_STATUS.to_string()),
    ]);
    assert!(newly_finished(&previous, &[], &statuses, &HashMap::new()).is_empty());
}

// A turn only agents worked in (another workspace's request) used to
// turn Done in the notch, though the backend sent no notification and
// the sidebar did not mark it unread.
#[test]
fn a_quiet_turn_is_not_finished_and_the_users_own_turn_is() {
    let mut memo = FeedMemo::default();
    for status in ["completed", "error"] {
        let quiet = serde_json::json!({"session_id": "a", "status": status, "quiet": true});
        assert!(memo.note(&event("session_turn_completed", quiet)));
        assert_eq!(memo.statuses.get("a").map(String::as_str), Some(QUIET_STATUS));
        let previous = [session("a", SessionState::Running)];
        assert!(newly_finished(&previous, &[], &memo.statuses, &memo.goals).is_empty(), "{status}");
    }

    // The user wrote into the session: the backend notifies and drops `quiet`.
    memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"})));
    memo.note(&event("desktop_notification", serde_json::json!({"kind": "assistant_done", "session_id": "a", "title": "Done · infra", "body": "Orders"})));
    memo.note(&event("session_turn_completed", serde_json::json!({"session_id": "a", "status": "completed"})));
    let finished = newly_finished(&[session("a", SessionState::Running)], &[], &memo.statuses, &memo.goals);
    assert_eq!(finished.iter().map(|s| s.state).collect::<Vec<_>>(), [SessionState::Done]);
}

// Decision: a session another workspace started, whose outcome was
// missed, is not guessed Done; one the user started still is.
#[test]
fn a_missed_outcome_reads_done_except_for_an_agent_started_session() {
    let mut sent = session("s", SessionState::Running);
    sent.sent_from = Some("sender".into());
    let previous = [session("a", SessionState::Running), sent];
    let finished = newly_finished(&previous, &[], &HashMap::new(), &HashMap::new());
    assert_eq!(ids(&finished), ["a"]);

    // A known outcome still counts for it (the user wrote into it).
    let statuses = HashMap::from([(id_key("s"), "error".to_string())]);
    let finished = newly_finished(&previous[1..], &[], &statuses, &HashMap::new());
    assert_eq!(finished.iter().map(|s| s.state).collect::<Vec<_>>(), [SessionState::Failed]);
}

// A compaction's start event can land after a list that showed the
// session as running; the next list hid it, and it turned Done.
#[test]
fn an_idle_compaction_seen_late_is_still_not_news() {
    let mut memo = FeedMemo::default();
    let previous = [session("a", SessionState::Running)];
    memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a", "idle_compaction": true})));
    let mut next = previous.to_vec();
    memo.hide_compacting(&mut next);
    assert!(next.is_empty());
    assert!(newly_finished(&previous, &next, &memo.statuses, &memo.goals).is_empty());

    // A normal turn forgets it.
    memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"})));
    assert!(memo.statuses.is_empty() && memo.compacting.is_empty());
}

#[test]
fn a_compaction_whose_session_left_the_list_is_forgotten() {
    let mut memo = FeedMemo::default();
    memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a", "idle_compaction": true})));
    memo.prune_compacting(&HashSet::from([id_key("a")]));
    assert!(memo.compacting.contains("a"), "still running");
    memo.prune_compacting(&HashSet::new());
    assert!(memo.compacting.is_empty(), "its end was missed, but it is over");
}

// An outage used to empty the list it diffs against, so a session
// that finished meanwhile was never reported.
#[test]
fn a_session_that_finished_during_an_outage_is_reported_once_back() {
    let mut feeds = two_servers(&[], &["r", "s"]);
    assert!(feeds.clear_sessions(&remote()));
    assert!(feeds.lists().1.is_empty(), "nothing is reported while it is away");
    feeds.update(&remote(), vec![session("s", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    let (sessions, unread) = feeds.lists();
    assert_eq!((ids(&sessions), ids(&unread)), (vec!["s"], vec!["r"]));

    // How it ended still applies: a stopped turn stays quiet after a reconnect.
    feeds.clear_sessions(&remote());
    let statuses = HashMap::from([(id_key("s"), "stopped".to_string())]);
    feeds.update(&remote(), vec![], &statuses, &HashMap::new(), None, true);
    assert_eq!(ids(&feeds.lists().1), ["r"]);
}

// A turn that failed within moments of starting was never in a list,
// so the notch missed the Failed row the sidebar showed.
#[test]
fn a_turn_that_ended_before_any_list_saw_it_is_unread() {
    let mut memo = FeedMemo::default();
    memo.note(&event("session_turn_started", serde_json::json!({"session_id": "f"})));
    let failed = serde_json::json!({"kind": "assistant_done", "session_id": "f", "title": "Failed · web", "body": "Fix the build"});
    assert!(!memo.note(&event("desktop_notification", failed)));
    memo.note(&event("session_turn_completed", serde_json::json!({"session_id": "f", "status": "error"})));
    // A quiet one and a stopped one leave nothing (no notification, or none kept).
    memo.note(&event("session_turn_completed", serde_json::json!({"session_id": "q", "status": "completed", "quiet": true})));
    let late = memo.take_late();
    assert_eq!(late.len(), 1);
    assert_eq!((late[0].title.as_str(), late[0].workspace.as_deref(), late[0].state), ("Fix the build", Some("web"), SessionState::Failed));

    let mut feeds = two_servers(&["a"], &[]);
    assert!(feeds.add_late(&ServerId::Bundled, late.clone(), &[session("a", SessionState::Running)], None, true));
    let unread = feeds.lists().1;
    assert_eq!(ids(&unread), ["f"]);
    assert_eq!(unread[0].server_id, Some(ServerId::Bundled));

    // The server says how the turn ended; the title's words are for people.
    let row = |title: &str, outcome: &str| notified_row("x", &serde_json::json!({"title": title, "body": "b", "outcome": outcome})).state;
    assert_eq!(row("Could not finish · web", "failed"), SessionState::Failed);
    assert_eq!(row("Failed to launch · web", "done"), SessionState::Done, "a workspace or wording that starts with Failed");

    // One the last list held is reported by `update` instead, once.
    let mut feeds = two_servers(&["f"], &[]);
    assert!(!feeds.add_late(&ServerId::Bundled, late.clone(), &[], None, true));
    // The session on screen, or with finished rows off, is not unread.
    let mut feeds = two_servers(&[], &[]);
    assert!(!feeds.add_late(&ServerId::Bundled, late.clone(), &[], Some("f"), true));
    assert!(!feeds.add_late(&ServerId::Bundled, late, &[], None, false));
}

// The pet keeps the questions of a server it can't reach right now.
#[test]
fn sessions_waiting_on_a_server_that_dropped_out_are_held() {
    let mut feeds = two_servers(&["a"], &[]);
    feeds.update(&remote(), vec![session("q", SessionState::NeedsInput), session("r", SessionState::Running)], &HashMap::new(), &HashMap::new(), None, true);
    assert!(feeds.held().is_empty(), "connected: the list says it all");
    feeds.clear_sessions(&remote());
    feeds.set_watch(&remote(), WatchState::Reconnecting);
    assert_eq!(feeds.held(), ["q"]);
    feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true);
    assert!(feeds.held().is_empty(), "back, and no longer waiting");
}

#[test]
fn every_finish_gets_its_own_number() {
    let previous = [session("a", SessionState::Running)];
    let first = newly_finished(&previous, &[], &HashMap::new(), &HashMap::new());
    let second = newly_finished(&previous, &[], &HashMap::new(), &HashMap::new());
    assert!(first[0].finished_seq.is_some());
    assert_ne!(first[0].finished_seq, second[0].finished_seq);
    let wire = serde_json::to_value(&first[0]).unwrap();
    assert!(wire["finishedSeq"].is_u64());
    assert!(serde_json::to_value(&previous[0]).unwrap().get("finishedSeq").is_none(), "only on finished rows");
}

// Decision: the sidebar nests a session another workspace started under
// its sender; the notch leaves it out while the sender is listed.
#[test]
fn an_agent_started_session_is_shown_under_its_listed_sender() {
    let mut rows = vec![row("sender", Some("Orders API"), false, false), row("spawned", Some("Orders table"), true, false), row("asks", Some("Region"), true, true)];
    rows[0].background_work = true;
    rows[1].sent_from = Some(SentFrom { session_id: Some("sender".into()) });
    rows[2].sent_from = Some(SentFrom { session_id: Some("sender".into()) });
    let mut feeds = Feeds::default();
    feeds.join(&ServerId::Bundled, BUILTIN_NAME.into());
    feeds.update(&ServerId::Bundled, active_sessions(rows, &HashMap::new(), None), &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(ids(&feeds.lists().0), ["asks", "sender"], "its question still shows");

    // The sender is done: the agent-started session shows on its own.
    let mut alone = row("spawned", Some("Orders table"), true, false);
    alone.sent_from = Some(SentFrom { session_id: Some("sender".into()) });
    feeds.update(&ServerId::Bundled, active_sessions(vec![alone], &HashMap::new(), None), &HashMap::new(), &HashMap::new(), None, true);
    assert_eq!(ids(&feeds.lists().0), ["spawned"]);
    assert!(feeds.lists().1.iter().all(|u| u.id != "spawned"));

    let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "running": true, "sent_from": {"session_id": "s", "workspace": "/r/app"}}, {"id": "b", "sent_from": null}]}"#).unwrap();
    assert_eq!(page.data[0].sent_from.as_ref().and_then(|s| s.session_id.as_deref()), Some("s"));
    assert!(page.data[1].sent_from.is_none());
}

#[test]
fn a_session_working_toward_a_goal_shows_the_turn_it_is_on() {
    let goal = |mut r: SessionRow, status: &str| {
        (r.goal_status, r.goal_turns_used, r.goal_max_turns) = (Some(status.into()), Some(6), Some(50));
        r
    };
    let mut between = goal(row("b", Some("Waits on subagents"), false, false), "active");
    between.background_work = true;
    let rows = vec![goal(row("a", Some("Migrate"), true, false), "active"), between, goal(row("c", Some("Paused one"), true, false), "paused")];
    let sessions = active_sessions(rows, &HashMap::new(), None);
    let goals: Vec<Option<IslandGoal>> = sessions.iter().map(|s| s.goal.clone()).collect();
    assert_eq!(
        goals,
        [Some(IslandGoal::Active { turn: 7, max_turns: 50 }), Some(IslandGoal::Active { turn: 6, max_turns: 50 }), None],
        "the running turn, the last one between turns, and nothing for a paused goal's own turn"
    );
    assert_eq!(serde_json::to_value(&goals[0]).unwrap(), serde_json::json!({"status": "active", "turn": 7, "maxTurns": 50}));

    let page: SessionPage = serde_json::from_str(r#"{"data": [{"id": "a", "running": true}]}"#).unwrap();
    assert_eq!(page.data[0].goal_status, None, "an older backend has no goals");
}

#[test]
fn a_goal_s_last_turn_says_what_became_of_the_goal() {
    let mut memo = FeedMemo::default();
    let note = serde_json::json!({"kind": "assistant_done", "session_id": "a", "title": "Goal achieved · web", "goal": "achieved"});
    assert!(!memo.note(&event("desktop_notification", note)), "the turn's completion refetches");
    let blocked = serde_json::json!({"kind": "assistant_done", "session_id": "b", "goal": "blocked"});
    memo.note(&event("desktop_notification", blocked));

    let previous = [session("a", SessionState::Running), session("b", SessionState::Running), session("c", SessionState::Running)];
    let finished = newly_finished(&previous, &[], &memo.statuses, &memo.goals);
    let got: Vec<(&str, SessionState, Option<IslandGoal>)> = finished.iter().map(|s| (s.id.as_str(), s.state, s.goal.clone())).collect();
    assert_eq!(
        got,
        [
            ("a", SessionState::Done, Some(IslandGoal::Achieved)),
            ("b", SessionState::Done, Some(IslandGoal::Blocked)),
            ("c", SessionState::Done, None),
        ]
    );
    assert_eq!(serde_json::to_value(&finished[0].goal).unwrap(), serde_json::json!({"status": "achieved"}));

    // A new turn (the user moved on) is not the goal's.
    assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
    assert!(!memo.goals.contains_key("a"));
    assert!(memo.note(&event("session_goal", serde_json::json!({"session_id": "a"}))), "goal progress refetches");
}

#[test]
fn unread_is_newest_first_and_skips_the_session_on_screen() {
    let mut unread = vec![session("old", SessionState::Done)];
    let finished = vec![session("a", SessionState::Done), session("seen", SessionState::Failed)];
    assert!(merge_unread(&mut unread, finished, &[], Some(&id_key("seen"))));
    let ids: Vec<&str> = unread.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["a", "old"]);

    assert!(!merge_unread(&mut unread, vec![], &[], None), "nothing changed");
}

#[test]
fn unread_drops_a_session_that_runs_again_and_keeps_the_newest_few() {
    let mut unread = vec![session("a", SessionState::Done)];
    assert!(merge_unread(&mut unread, vec![], &[session("a", SessionState::Running)], None));
    assert!(unread.is_empty());

    let finished: Vec<IslandSession> = (0..MAX_UNREAD + 2).map(|i| session(&format!("s{i}"), SessionState::Done)).collect();
    merge_unread(&mut unread, finished, &[], None);
    assert_eq!(unread.len(), MAX_UNREAD);
    assert_eq!(unread[0].id, "s0");
}

#[test]
fn an_idle_compaction_stays_out_of_the_list_and_is_not_news() {
    let mut memo = FeedMemo::default();
    let start = serde_json::json!({"session_id": "a", "idle_compaction": true});
    assert!(memo.note(&event("session_turn_started", start)));
    let mut next = vec![session("a", SessionState::Running), session("b", SessionState::Running)];
    memo.hide_compacting(&mut next);
    assert_eq!(next.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b"]);

    let end = serde_json::json!({"session_id": "a", "status": "completed", "idle_compaction": true});
    assert!(memo.note(&event("session_turn_completed", end)));
    assert_eq!(memo.statuses.get("a").map(String::as_str), Some(IDLE_COMPACTION_STATUS));
    let mut next = vec![session("a", SessionState::Running)];
    memo.hide_compacting(&mut next);
    assert_eq!(next.len(), 1, "the compaction is over");
}

#[test]
fn turn_events_trigger_a_refetch_and_others_do_not() {
    let mut memo = FeedMemo::default();
    assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
    assert!(memo.note(&event("title_update", serde_json::json!({}))));
    assert!(!memo.note(&event("config_changed", serde_json::json!({}))));
    assert!(!memo.note(&event("desktop_notification", serde_json::json!({"kind": "assistant_done"}))));
    // A subagent ending can finish its lead, but leaves no outcome to keep.
    let subagent = serde_json::json!({"session_id": "s", "status": "completed", "parent_session_id": "a"});
    assert!(memo.note(&event("session_turn_completed", subagent)));
    assert!(memo.statuses.is_empty());
}

#[test]
fn the_memo_keeps_questions_and_outcomes_only_while_they_apply() {
    let mut memo = FeedMemo::default();
    let ask = serde_json::json!({"kind": "input_needed", "session_id": "a", "body": "Which branch?"});
    assert!(memo.note(&event("desktop_notification", ask)));
    let done = serde_json::json!({"session_id": "b", "status": "error"});
    assert!(memo.note(&event("session_turn_completed", done)));
    assert_eq!(memo.questions.get("a").and_then(|q| q.text.as_deref()), Some("Which branch?"));
    assert_eq!(memo.statuses.get("b").map(String::as_str), Some("error"));

    memo.settle(&[session("a", SessionState::Running)]);
    assert!(memo.questions.is_empty(), "answered: the question no longer applies");
    assert!(memo.statuses.is_empty());

    memo.statuses.insert("a".into(), "completed".into());
    assert!(memo.note(&event("session_turn_started", serde_json::json!({"session_id": "a"}))));
    assert!(memo.statuses.is_empty(), "a new turn forgets the last outcome");
}

fn open_question(id: &str, text: &str, options: &[&str]) -> crate::answers::OpenQuestion {
    let options: Vec<_> = options.iter().map(|label| serde_json::json!({ "label": label })).collect();
    let body = serde_json::json!({ "question": { "id": id, "questions": [{ "question": text, "options": options }] } });
    crate::answers::parse_question(&body).unwrap()
}

// The notification only has text; the server's copy adds the id.
#[test]
fn the_servers_copy_of_a_question_adds_its_id_to_the_notification_text() {
    let mut memo = FeedMemo::default();
    let ask = serde_json::json!({"kind": "input_needed", "session_id": "a", "body": "Which branch?"});
    memo.note(&event("desktop_notification", ask));
    memo.learn("a", Some(&open_question("q-1", "Which branch? (main or dev)", &["main", "dev"])));
    let asked = memo.questions.get("a").unwrap();
    assert_eq!((asked.id.as_deref(), asked.text.as_deref()), (Some("q-1"), Some("Which branch? (main or dev)")));

    // Nothing open any more (answered meanwhile): no stale id.
    memo.learn("a", None);
    let asked = memo.questions.get("a").unwrap();
    assert_eq!(asked.id.as_deref(), None);
    assert_eq!(asked.text.as_deref(), Some("Which branch? (main or dev)"));
}

// Every refresh (each event of any session) used to ask the server
// again for the question of every waiting session, up to 8 requests.
#[test]
fn a_question_is_read_from_the_server_once_until_the_session_asks_again() {
    let waiting = |id: &str| SessionRow { needs_input: true, ..serde_json::from_value(serde_json::json!({ "id": id })).unwrap() };
    let rows = [waiting("a"), waiting("b")];
    let ids = |memo: &FeedMemo| memo.questions_to_read(&rows).iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let mut memo = FeedMemo::default();
    assert_eq!(ids(&memo), ["a", "b"]);

    memo.learn("a", Some(&open_question("q-1", "Which branch?", &["main", "dev"])));
    assert_eq!(ids(&memo), ["b"], "a's question is known");
    // The server had nothing for b (a race with the list): ask again.
    memo.learn("b", None);
    assert_eq!(ids(&memo), ["b"]);

    // a was answered and asks something else: its id is another one.
    let ask = serde_json::json!({"kind": "input_needed", "session_id": "a", "body": "Which remote?"});
    memo.note(&event("desktop_notification", ask));
    assert_eq!(ids(&memo), ["a", "b"]);
    // Until it is read, the row holds no id: q-1 is answered and gone.
    let asked = &memo.questions[&id_key("a")];
    assert_eq!((asked.text.as_deref(), asked.id.as_deref()), (Some("Which remote?"), None));

    // Events missed while disconnected may have been just that.
    memo.learn("a", Some(&open_question("q-2", "Which remote?", &["origin"])));
    assert_eq!(ids(&memo), ["b"]);
    memo.connected();
    assert_eq!(ids(&memo), ["a", "b"]);
}

#[test]
fn answering_clears_the_waiting_row_on_every_server_it_is_listed_on() {
    let mut feeds = two_servers(&["a"], &["r"]);
    let mut asked = session("q", SessionState::NeedsInput);
    asked.question = Some("Which branch?".into());
    asked.question_id = Some("q-1".into());
    feeds.update(&remote(), vec![session("r", SessionState::Running), asked], &HashMap::new(), &HashMap::new(), None, true);
    assert!(feeds.resolve_question("q"));
    let (sessions, _) = feeds.lists();
    let row = sessions.iter().find(|s| s.id == "q").unwrap();
    assert_eq!((row.state, row.question.as_deref(), row.question_id.as_deref()), (SessionState::Running, None, None));
    assert!(!feeds.resolve_question("q"), "already clear");
    assert!(!feeds.resolve_question("a"), "a running session has no question to clear");
}

// The island used to drop a lost server's rows without a word.
#[test]
fn a_server_that_keeps_failing_after_it_answered_is_announced_as_unreachable() {
    let mut feeds = two_servers(&["a"], &["r"]);
    assert!(feeds.unreachable().is_empty());

    feeds.clear_sessions(&remote());
    feeds.set_watch(&remote(), WatchState::Reconnecting);
    assert!(!feeds.set_failures(&remote(), 1), "one failed retry is a blip");
    assert!(feeds.unreachable().is_empty());
    assert!(feeds.set_failures(&remote(), UNREACHABLE_AFTER_FAILURES), "the second one is not");
    assert_eq!(
        feeds.unreachable(),
        [UnreachableServer { id: REMOTE.into(), name: REMOTE_NAME.into(), reason: "unreachable" }]
    );
    assert_eq!(serde_json::to_value(&feeds.unreachable()[0]).unwrap(), serde_json::json!({"id": REMOTE, "name": REMOTE_NAME, "reason": "unreachable"}));

    // It is back: the row goes with the next list.
    assert!(feeds.update(&remote(), vec![], &HashMap::new(), &HashMap::new(), None, true));
    assert!(feeds.unreachable().is_empty());
}

#[test]
fn a_server_that_never_answered_is_not_announced_but_a_refused_key_is() {
    let mut feeds = Feeds::default();
    feeds.join(&remote(), REMOTE_NAME.into());
    feeds.set_watch(&remote(), WatchState::Reconnecting);
    feeds.set_failures(&remote(), 5);
    assert!(feeds.unreachable().is_empty(), "a laptop asleep since launch is not news");

    feeds.set_watch(&remote(), WatchState::KeyRejected);
    assert_eq!(feeds.unreachable()[0].reason, "key_rejected");
}

#[test]
fn the_snapshot_changes_when_only_the_unreachable_servers_do() {
    let mut shared = Shared {
        status: IslandStatus::default(),
        feeds: two_servers(&["a"], &[]),
        geometry: NotchGeometry::default(),
        settings: IslandSettings::default(),
        frontmost: false,
        wants_visible: false,
        size: (0.0, 0.0),
        shift: 0.0,
        canvas: None,
        pill: None,
        pointer: None,
        menu_open: false,
        viewing: HashMap::new(),
        saved: Vec::new(),
        names: Default::default(),
        refresh_requested: HashSet::new(),
    };
    assert!(shared.rebuild().is_some());
    assert!(shared.rebuild().is_none(), "nothing changed");
    shared.feeds.set_watch(&remote(), WatchState::Reconnecting);
    shared.feeds.set_failures(&remote(), UNREACHABLE_AFTER_FAILURES);
    shared.feeds.servers.get_mut(&remote()).unwrap().ever_connected = true;
    let status = shared.rebuild().expect("the unreachable row is a change");
    assert_eq!(status.unreachable.len(), 1);
    assert_eq!(status.seq, 2);
}

#[test]
fn the_island_opens_on_a_click_by_default_and_hover_is_an_option() {
    assert!(!IslandSettings::default().expand_on_hover);
    let hover: IslandSettingsPatch = serde_json::from_str(r#"{"expandOnHover": true}"#).unwrap();
    assert!(IslandSettings::default().with(hover).expand_on_hover);
    let saved: IslandSettings = serde_json::from_str(r#"{"enabled": true}"#).unwrap();
    assert!(!saved.expand_on_hover, "settings saved before it existed open on a click");
}

#[test]
fn a_session_path_names_the_session_to_open() {
    let id = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
    assert_eq!(session_id_from_path(&format!("/{id}")).as_deref(), Some(id));
    assert_eq!(session_id_from_path(&format!("/{id}?tab=review")).as_deref(), Some(id));
    assert_eq!(session_id_from_path(&format!("/{id}/files#top")).as_deref(), Some(id));
    for other in ["", "/", "/settings", "/new", "/../x", "/abc"] {
        assert_eq!(session_id_from_path(other), None, "{other}");
    }
}

/// A widget's open (the island, the pet) asks the page to leave focus
/// where it is; an OS notification's open does not.
#[test]
fn a_widget_open_asks_the_page_to_leave_focus_alone() {
    let id = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
    assert_eq!(open_path(id, true), format!("/{id}?quiet=1"));
    assert_eq!(open_path(id, false), format!("/{id}"));
    assert_eq!(session_id_from_path(&open_path(id, true)).as_deref(), Some(id));
    assert_eq!(open_payload(id, true, 7), serde_json::json!({ "sessionId": id, "id": 7, "quiet": true }));
    assert_eq!(open_payload(id, false, 8), serde_json::json!({ "sessionId": id, "id": 8 }));
}

#[test]
fn sse_events_survive_chunks_split_anywhere() {
    let wire = "event: session_turn_started\r\ndata: {\"session_id\":\"a\u{e9}\"}\r\n\r\n: ping\r\n\r\nevent: title_update\r\ndata: one\r\ndata: two\r\n\r\n";
    let bytes = wire.as_bytes();
    for split in 0..bytes.len() {
        let mut parser = SseParser::default();
        let mut events = parser.push(&bytes[..split]);
        events.extend(parser.push(&bytes[split..]));
        assert_eq!(
            events,
            vec![
                SseEvent { event: "session_turn_started".into(), data: "{\"session_id\":\"a\u{e9}\"}".into() },
                SseEvent { event: "title_update".into(), data: "one\ntwo".into() },
            ],
            "split at {split}"
        );
    }
}

fn notched() -> ScreenInfo {
    // A 14" MacBook Pro at its default scaling, as NSScreen reports it:
    // the notch is 185 x 32 pt, a little off centre (663 pt of menu bar
    // left of it, 664 right), under a 37 pt menu bar.
    ScreenInfo {
        frame: Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
        visible_top: 945.0,
        safe_top: 32.0,
        aux_left_width: 663.0,
        aux_right_width: 664.0,
        scale: 2.0,
    }
}

fn external() -> ScreenInfo {
    ScreenInfo {
        frame: Rect { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 },
        visible_top: 1215.0,
        safe_top: 0.0,
        aux_left_width: 0.0,
        aux_right_width: 0.0,
        scale: 1.0,
    }
}

#[test]
fn the_notched_display_wins_and_otherwise_the_primary_one() {
    assert_eq!(pick_screen(&[external(), notched()]), Some(notched()));
    assert_eq!(pick_screen(&[external()]), Some(external()));
    assert_eq!(pick_screen(&[]), None);
}

#[test]
fn notch_geometry_comes_from_the_menu_bar_areas_beside_it() {
    assert_eq!(notch_geometry(&notched()), NotchGeometry { has_notch: true, width: 185.0, height: 32.0 });
    let plain = notch_geometry(&external());
    assert_eq!(plain, NotchGeometry { has_notch: false, width: FALLBACK_PILL_WIDTH, height: 25.0 });

    let mut hidden_menu_bar = external();
    hidden_menu_bar.visible_top = hidden_menu_bar.frame.y + hidden_menu_bar.frame.height;
    assert_eq!(notch_geometry(&hidden_menu_bar).height, FALLBACK_MENU_BAR_HEIGHT);
}

// Nothing watched the displays: the island stayed where the last fit,
// focus change or settings change had put it.
#[test]
fn the_island_follows_a_display_that_was_plugged_in_or_unplugged() {
    let on = |screen: &ScreenInfo| (island_frame(screen, CANVAS_WIDTH, CANVAS_HEIGHT), notch_geometry(screen));
    let (canvas, geometry) = on(&external());
    assert!(!display_changed(&canvas, &geometry, &[external()]), "the same display: stay put");
    // The lid opens: the notched display is listed, and the island belongs on it.
    assert!(display_changed(&canvas, &geometry, &[external(), notched()]));
    // The lid closes: back to the display that is left.
    let (canvas, geometry) = on(&notched());
    assert!(display_changed(&canvas, &geometry, &[external()]));
    // The same place but a taller menu bar: the pill's shape changed.
    let (canvas, geometry) = on(&external());
    let taller = ScreenInfo { visible_top: external().visible_top - 12.0, ..external() };
    assert!(display_changed(&canvas, &geometry, &[taller]));
    // No display at all (asleep): nothing to move to.
    assert!(!display_changed(&canvas, &geometry, &[]));
}

#[test]
fn the_island_is_centred_on_the_notch_and_flush_with_the_top() {
    // Notch 663..848, centre 755.5.
    let frame = island_frame(&notched(), 340.0, 32.0);
    assert_eq!(frame, Rect { x: 585.5, y: 950.0, width: 340.0, height: 32.0 });
    let frame = island_frame(&external(), 220.0, 25.0);
    assert_eq!(frame, Rect { x: 1512.0 + 1170.0, y: 1215.0, width: 220.0, height: 25.0 });
}

// Rounded to whole points, the canvas sat 0.5 pt right of the notch's
// centre, and the pill showed a 1 px black sliver past the notch's edge.
#[test]
fn an_odd_notch_gets_equal_wings_on_a_whole_device_pixel() {
    let wing = 36.0;
    let pill = island_frame(&notched(), 185.0 + 2.0 * wing, 32.0);
    assert_eq!(pill.x, 663.0 - wing, "left wing");
    assert_eq!(pill.x + pill.width, 848.0 + wing, "right wing");
    // The canvas the pill is centred in shares the notch's centre too.
    let canvas = island_frame(&notched(), CANVAS_WIDTH, CANVAS_HEIGHT);
    assert_eq!(canvas.x + canvas.width / 2.0, 755.5);
    assert_eq!(canvas.x * notched().scale, (canvas.x * notched().scale).round(), "whole device pixel");
    // At 1x a half point is not a pixel: whole points, as before.
    let one_x = ScreenInfo { scale: 1.0, ..notched() };
    assert_eq!(island_frame(&one_x, 340.0, 32.0).x, 586.0);
}

#[test]
fn a_shifted_pill_moves_by_the_shift_and_stays_inside_the_canvas() {
    let pill = pill_frame(&notched(), 240.0, 32.0, -26.0);
    assert_eq!(pill.x, island_frame(&notched(), 240.0, 32.0).x - 26.0);
    // No shift (what the island sends today) is the centred frame.
    assert_eq!(pill_frame(&notched(), 340.0, 32.0, 0.0), island_frame(&notched(), 340.0, 32.0));
    // A shift past the canvas edge, or garbage, is held to the canvas.
    let canvas = island_frame(&notched(), CANVAS_WIDTH, CANVAS_HEIGHT);
    let far = pill_frame(&notched(), 400.0, 32.0, -500.0);
    assert_eq!(far.x, canvas.x);
    assert_eq!(pill_frame(&notched(), 340.0, 32.0, f64::NAN), island_frame(&notched(), 340.0, 32.0));
}

#[test]
fn requested_sizes_are_clamped() {
    assert_eq!(fit_size(2_000.0, 2_000.0), (CANVAS_WIDTH, CANVAS_HEIGHT));
    assert_eq!(fit_size(f64::NAN, -4.0), (MIN_SIZE, MIN_SIZE));
    assert_eq!(fit_size(300.4, 37.2), (301.0, 38.0));
}

#[test]
fn the_island_shows_only_when_on_wanted_and_the_app_is_in_the_background() {
    let on = IslandSettings::default();
    assert!(should_show(&on, false, true));
    assert!(!should_show(&IslandSettings { enabled: false, ..on }, false, true));
    assert!(!should_show(&on, true, true), "hidden while OpenAgentd is in front");
    assert!(!should_show(&on, false, false), "nothing to show");
}

#[test]
fn opting_in_keeps_the_island_up_while_the_app_is_in_front() {
    let opted_in = IslandSettings { show_when_frontmost: true, ..IslandSettings::default() };
    assert!(should_show(&opted_in, true, true));
    assert!(!should_show(&IslandSettings { enabled: false, ..opted_in }, true, true));
}

#[test]
fn a_settings_patch_changes_only_what_it_names() {
    let patch: IslandSettingsPatch = serde_json::from_str(r#"{"showWhenFrontmost": true}"#).unwrap();
    let next = IslandSettings::default().with(patch);
    assert_eq!(next, IslandSettings { show_when_frontmost: true, ..IslandSettings::default() });
    let json = serde_json::to_value(next).unwrap();
    assert_eq!(json["showWhenFrontmost"], true, "the web reads camelCase: {json}");
}

// The setting was removed; a file saved with it still loads.
#[test]
fn settings_saved_with_the_removed_idle_option_still_load() {
    let saved: IslandSettings = serde_json::from_str(r#"{"enabled": false, "showWhenIdle": true}"#).unwrap();
    assert_eq!(saved, IslandSettings { enabled: false, ..IslandSettings::default() });
}

#[test]
fn the_pointer_is_reported_in_canvas_pixels_from_the_top_left() {
    let canvas = Rect { x: 526.0, y: 602.0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    assert_eq!(canvas_point(&canvas, 526.0, 982.0), (0.0, 0.0));
    assert_eq!(canvas_point(&canvas, 756.0, 962.0), (230.0, 20.0));
}

#[test]
fn the_pointer_is_over_the_island_inside_its_frame_edges_included() {
    let frame = Rect { x: 586.0, y: 944.0, width: 340.0, height: 38.0 };
    assert!(frame.contains(700.0, 960.0));
    assert!(frame.contains(586.0, 982.0), "top-left corner");
    assert!(!frame.contains(585.0, 960.0));
    assert!(!frame.contains(700.0, 943.0), "just below");
}

#[test]
fn workspace_labels_are_the_folder_name() {
    assert_eq!(workspace_label("/Users/me/code/web/"), Some("web".into()));
    assert_eq!(workspace_label("C:\\code\\api"), Some("api".into()));
    assert_eq!(workspace_label("/"), None);
}

#[test]
fn the_pointer_is_read_less_often_the_further_it_is_from_the_island() {
    let canvas = Rect { x: 526.0, y: 602.0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    let at = |inside, x, y| Some(PointerPayload { inside, x, y });
    assert_eq!(pointer_poll_interval(&canvas, at(true, 230.0, 20.0)), POINTER_POLL_INSIDE, "over the pill");
    assert_eq!(pointer_poll_interval(&canvas, at(false, 230.0, CANVAS_HEIGHT + 100.0)), POINTER_POLL, "just below the canvas");
    assert_eq!(pointer_poll_interval(&canvas, at(false, -100.0, 10.0)), POINTER_POLL, "beside it in the menu bar");
    assert_eq!(pointer_poll_interval(&canvas, at(false, 230.0, CANVAS_HEIGHT + 600.0)), POINTER_FAR_POLL, "down in a window");
    assert_eq!(pointer_poll_interval(&canvas, at(false, CANVAS_WIDTH + 500.0, 10.0)), POINTER_FAR_POLL, "far along the menu bar");
    assert_eq!(pointer_poll_interval(&canvas, None), POINTER_POLL, "not read yet");
}
