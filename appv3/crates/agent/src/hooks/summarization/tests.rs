use super::*;
use appv3_providers::mock::MockProvider;

fn hook(keep_last: usize) -> SummarizationHook {
    hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")])), keep_last)
}

/// The per-model-call threshold read is served from memory until
/// `settings.yaml` changes, and picks the change up on the next call.
#[test]
fn custom_threshold_is_cached_until_settings_yaml_changes() {
    use std::time::{Duration, SystemTime};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.yaml");
    let write = |value: &str, mtime: SystemTime| {
        std::fs::write(&path, format!("summarization:\n  prompt_token_threshold: {value}\n")).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
    };
    let saved = SystemTime::now() - Duration::from_secs(3600);

    write("15000", saved);
    assert_eq!(cached_custom_threshold(&path), Some(15_000));
    // Same size and mtime: the file is not re-parsed.
    write("16000", saved);
    assert_eq!(cached_custom_threshold(&path), Some(15_000), "unchanged file was re-parsed");
    // A save moves the mtime: the next call sees the new value.
    write("50000", saved + Duration::from_secs(60));
    assert_eq!(cached_custom_threshold(&path), Some(50_000));
    // A just-written file is always re-read, so two saves inside one
    // coarse mtime tick are not missed.
    let now = SystemTime::now();
    write("20000", now);
    assert_eq!(cached_custom_threshold(&path), Some(20_000));
    write("30000", now);
    assert_eq!(cached_custom_threshold(&path), Some(30_000));
    // Deleting the override falls back to the auto threshold.
    std::fs::remove_file(&path).unwrap();
    assert_eq!(cached_custom_threshold(&path), None);
}

fn hook_with(provider: Arc<MockProvider>, keep_last: usize) -> SummarizationHook {
    SummarizationHook {
        provider,
        model_id: None,
        custom_threshold: Arc::new(|| Some(1)),
        keep_last,
        summary_prompt: "test summary prompt".into(),
        max_token_length: 0,
        context_window: None,
        min_since_last: 0,
        support_interrupt: true,
        at_last_summary: Mutex::new(0),
        pending: Mutex::new(false),
        plan_dir: None,
        on_summary: None,
    }
}

/// A persisted Plan/Code instruction note as history loading yields it.
fn mode_note(mode: &str) -> ChatMessage {
    let mut m = ChatMessage::user(format!("<interaction_mode>\n## {mode} mode\n</interaction_mode>"));
    let meta = m.meta_mut();
    meta.kind = "note".into();
    meta.pinned = true;
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert("interaction_mode".into(), json!(mode));
    extra.insert("interaction_mode_prompt".into(), json!(true));
    meta.extra = Some(extra);
    m
}

async fn compact(keep_last: usize, messages: Vec<ChatMessage>) -> AgentState {
    compact_with(&hook(keep_last), messages).await
}

fn ctx() -> RunContext {
    RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None }
}

#[test]
fn summarization_spans_name_their_session_and_workspace() {
    let with_ws = RunContext { session_id: Some("s-1".into()), run_id: "run".into(), agent_name: "lead".into(), workspace: Some("/w/app".into()) };
    let attrs: HashMap<&str, Value> = span_identity(&with_ws).into_iter().collect();
    assert_eq!(attrs["gen_ai.conversation.id"], "s-1");
    assert_eq!(attrs["gen_ai.agent.name"], "lead");
    assert_eq!(attrs["run_id"], "run");
    assert_eq!(attrs[WORKSPACE_ATTR], "/w/app");
    let attrs: HashMap<&str, Value> = span_identity(&ctx()).into_iter().collect();
    assert!(!attrs.contains_key(WORKSPACE_ATTR));
}

async fn compact_with(hook: &SummarizationHook, messages: Vec<ChatMessage>) -> AgentState {
    let mut state = AgentState::new(messages, String::new());
    assert!(hook.summarise(&ctx(), &mut state, "sys").await, "compaction did not run");
    state
}

fn find<'a>(state: &'a AgentState, content: &str) -> (usize, &'a ChatMessage) {
    state.messages.iter().enumerate().find(|(_, m)| m.content() == Some(content)).unwrap_or_else(|| panic!("no message {content:?}"))
}

fn summary_index(state: &AgentState) -> usize {
    state.messages.iter().position(|m| m.meta().is_summary()).expect("summary inserted")
}

fn visible(state: &AgentState, content: &str) -> bool {
    state.messages_for_llm().iter().any(|m| m.content() == Some(content))
}

/// Compacting a Plan-mode session must not drop the Plan instructions: the
/// note is appended once per switch and not re-added while it exists in
/// history, so losing it leaves the model without the read-only workflow
/// and plan tools for the rest of the mode.
/// `/compact` and idle compaction mark their summary `forced`, so the UI
/// can show it apart from the reply before it; auto-compaction does not.
#[tokio::test]
async fn forced_compaction_marks_its_summary() {
    let history = || vec![ChatMessage::user("Fix it."), ChatMessage::assistant("Fixed.")];
    let forced_of = |state: &AgentState| {
        let summary = &state.messages[summary_index(state)];
        summary.meta().extra.as_ref().and_then(|e| e.get("forced")).cloned()
    };

    let auto = compact(0, history()).await;
    assert_eq!(forced_of(&auto), None);

    let mut state = AgentState::new(history(), String::new());
    state.meta_set("force_summarization", json!(true));
    assert!(hook(0).summarise(&ctx(), &mut state, "sys").await, "compaction did not run");
    assert_eq!(forced_of(&state), Some(json!(true)));
}

/// Anthropic binds a signed thinking block to the conversation before
/// it. Our summary replaces that conversation, so a kept turn sent with
/// its old thinking fails with "bound to a different conversation".
#[tokio::test]
async fn kept_turns_lose_their_signed_thinking_after_a_summary() {
    let thought = |text: &str| {
        let mut a = appv3_providers::AssistantMessage {
            content: Some(text.into()),
            reasoning_content: Some("why".into()),
            reasoning_signature: Some("sig".into()),
            raw_content_blocks: Some(vec![json!({"type": "thinking", "thinking": "why", "signature": "sig"}), json!({"type": "text", "text": text})]),
            ..Default::default()
        };
        let mut extra = Map::new();
        extra.insert("reasoning_signature".into(), json!("sig"));
        a.meta.extra = Some(extra);
        ChatMessage::Assistant(a)
    };
    let history = vec![ChatMessage::user("one"), thought("first reply"), ChatMessage::user("two"), thought("second reply")];

    let state = compact(1, history).await;

    let (_, kept) = find(&state, "second reply");
    let ChatMessage::Assistant(a) = kept else { panic!("not an assistant message") };
    assert_eq!(a.reasoning_signature, None);
    assert_eq!(a.raw_content_blocks.as_deref(), Some(&[json!({"type": "text", "text": "second reply"})][..]));
    assert_eq!(a.reasoning_content.as_deref(), Some("why"), "the readable reasoning stays");
    assert!(a.meta.extra.as_ref().is_none_or(|e| !e.contains_key("reasoning_signature")));
}

#[tokio::test]
async fn active_plan_mode_note_stays_in_context_after_compaction() {
    let note = mode_note("plan");
    let note_text = note.content().unwrap().to_string();
    let state = compact(0, vec![note, ChatMessage::user("Redesign the settings screen."), ChatMessage::assistant("I will inspect the current UI.")]).await;

    assert!(visible(&state, &note_text), "Plan-mode note left the LLM window");
    let (idx, kept) = find(&state, &note_text);
    // Pinned so the derived DB window (pinned rows + rows after the
    // summary) still contains it when the session is reloaded.
    assert!(kept.meta().pinned);
    assert!(idx < summary_index(&state));
    assert!(!visible(&state, "Redesign the settings screen."));
    assert!(!visible(&state, "I will inspect the current UI."));
}

#[tokio::test]
async fn only_the_newest_mode_note_survives_compaction() {
    let plan = mode_note("plan");
    let code = mode_note("code");
    let (plan_text, code_text) = (plan.content().unwrap().to_string(), code.content().unwrap().to_string());
    let state = compact(
        0,
        vec![
            plan,
            ChatMessage::user("Plan the redesign."),
            ChatMessage::assistant("<proposed_plan>…</proposed_plan>"),
            code,
            ChatMessage::user("Approve, proceed."),
            ChatMessage::assistant("Implementing step 1."),
        ],
    )
    .await;

    assert!(visible(&state, &code_text));
    assert!(find(&state, &code_text).1.meta().pinned);
    assert!(!visible(&state, &plan_text));
    let (_, plan) = find(&state, &plan_text);
    assert!(plan.meta().exclude_from_context);
    assert!(!plan.meta().pinned);
}

/// Retention must not move the summary below a note it never covered.
#[tokio::test]
async fn mode_note_inside_the_kept_window_is_left_in_place() {
    let note = mode_note("plan");
    let note_text = note.content().unwrap().to_string();
    let state = compact(
        2,
        vec![
            ChatMessage::user("first"),
            ChatMessage::assistant("first reply"),
            ChatMessage::user("second"),
            ChatMessage::assistant("second reply"),
            note,
            ChatMessage::user("third"),
            ChatMessage::assistant("third reply"),
        ],
    )
    .await;

    let summary = summary_index(&state);
    let (kept_reply, _) = find(&state, "second reply");
    let (note_idx, _) = find(&state, &note_text);
    assert!(summary < kept_reply && kept_reply < note_idx, "summary {summary}, kept reply {kept_reply}, note {note_idx}");
    assert!(visible(&state, &note_text));
}

const PLAN: &str = "## Steps\n1. Build\n2. Test";

fn save_plan(dir: &std::path::Path, body: &str) {
    plan::save_agent(dir, plan::PlanTarget::DataDir, plan::PlanChange::Write(body)).unwrap();
}

/// A pinned `<session_plan>` note as an earlier compaction left it.
fn plan_note() -> ChatMessage {
    let mut m = ChatMessage::user(format!("<session_plan path=\"plan.md\">\n{PLAN}\n</session_plan>"));
    let meta = m.meta_mut();
    meta.kind = "note".into();
    meta.pinned = true;
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert(plan::SESSION_PLAN_KEY.into(), json!(true));
    meta.extra = Some(extra);
    m
}

fn plan_notes(state: &AgentState) -> Vec<(usize, &ChatMessage)> {
    state.messages.iter().enumerate().filter(|(_, m)| extra_truthy(m, plan::SESSION_PLAN_KEY)).collect()
}

fn summariser_request(provider: &MockProvider, call: usize) -> Vec<ChatMessage> {
    provider.calls.lock().unwrap()[call].0.clone()
}

/// Coding workspaces keep no assistant message verbatim, so without the
/// note the approved plan only survived as summary bullets and the agent
/// drifted off it after compaction.
#[tokio::test]
async fn compaction_restates_the_saved_plan_before_the_summary() {
    let dir = tempfile::tempdir().unwrap();
    save_plan(dir.path(), PLAN);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
    let state =
        compact_with(&hook, vec![mode_note("code"), ChatMessage::user("Plan it."), ChatMessage::assistant("Plan submitted."), ChatMessage::assistant("Implementing step 1.")])
            .await;

    let notes = plan_notes(&state);
    assert_eq!(notes.len(), 1);
    let (idx, note) = notes[0];
    assert!(note.meta().pinned && !note.meta().exclude_from_context);
    assert_eq!(note.meta().kind, "note");
    assert_eq!(idx + 1, summary_index(&state), "the summary is read after the plan");
    assert!(note.content().unwrap().contains(&format!("\n{PLAN}\n</session_plan>")));

    let request = summariser_request(&provider, 0);
    assert!(request.last().unwrap().content().unwrap().ends_with(plan::PLAN_SUMMARY_RULE));
}

#[tokio::test]
async fn a_later_compaction_replaces_the_plan_note() {
    let dir = tempfile::tempdir().unwrap();
    save_plan(dir.path(), PLAN);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
    let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
    let mut state = compact_with(&hook, vec![ChatMessage::user("Plan it."), ChatMessage::assistant("Plan written.")]).await;
    save_plan(dir.path(), "## Steps\n1. Build\n2. Test\n3. Ship");
    state.messages.push(ChatMessage::user("Add a ship step."));
    state.messages.push(ChatMessage::assistant("Added."));
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    let notes = plan_notes(&state);
    assert_eq!(notes.len(), 2);
    let (old, new) = (notes[0].1, notes[1].1);
    assert!(old.meta().exclude_from_context && !old.meta().pinned);
    assert!(new.meta().pinned && !new.meta().exclude_from_context);
    assert!(new.content().unwrap().contains("3. Ship"));
    let request = summariser_request(&provider, 1);
    assert!(request.iter().any(|m| m.content().is_some_and(|c| c.contains("<session_plan path="))), "the old note was cut from the summariser's history");
}

/// What a main turn sends for `state`: the system prompt, then the
/// visible history (`stream_and_assemble`).
fn main_turn_wire(state: &AgentState, system: &str) -> Vec<ChatMessage> {
    let mut wire = vec![ChatMessage::system(system)];
    wire.extend(state.messages_for_llm());
    merge_consecutive_user_messages(wire)
}

/// The summary request must be the main turn's request plus the summary
/// instruction, or it cannot read the prompt cache the turn just wrote.
fn assert_extends_main_turn(request: &[ChatMessage], main: &[ChatMessage]) {
    assert_eq!(request.len(), main.len() + 1, "the summary request is not the main turn plus one instruction");
    for (i, (sent, cached)) in request.iter().zip(main).enumerate() {
        assert_eq!(sent, cached, "the summary request rewrites message {i} of the main turn");
    }
}

/// A live goal's pinned rules note, as `goal::note_extra` marks it.
fn goal_note() -> ChatMessage {
    let mut m = ChatMessage::user("<session_goal>\nShip the settings redesign.\n</session_goal>");
    let meta = m.meta_mut();
    meta.kind = "note".into();
    meta.pinned = true;
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert("hidden_from_summary".into(), json!(true));
    extra.insert("goal_note".into(), json!(true));
    meta.extra = Some(extra);
    m
}

#[tokio::test]
async fn summary_request_extends_the_main_turn_with_a_live_goal_note() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = hook_with(provider.clone(), 0);
    let mut state = AgentState::new(
        vec![mode_note("code"), goal_note(), ChatMessage::user("Redesign settings."), ChatMessage::assistant("Step 1 done."), ChatMessage::assistant("Step 2 done.")],
        String::new(),
    );
    let main = main_turn_wire(&state, "sys");
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    assert_extends_main_turn(&summariser_request(&provider, 0), &main);
}

#[tokio::test]
async fn second_summary_request_extends_the_main_turn_with_the_plan_note() {
    let dir = tempfile::tempdir().unwrap();
    save_plan(dir.path(), PLAN);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
    let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
    let mut state = compact_with(&hook, vec![mode_note("code"), ChatMessage::user("Build it."), ChatMessage::assistant("Building.")]).await;
    state.messages.push(ChatMessage::user("Now test it."));
    state.messages.push(ChatMessage::assistant("Tests pass."));
    let main = main_turn_wire(&state, "sys");
    assert!(main.iter().any(|m| m.content().is_some_and(|c| c.contains("<session_plan path="))), "the main turn sends the restated plan");
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    assert_extends_main_turn(&summariser_request(&provider, 1), &main);
}

#[tokio::test]
async fn live_goal_note_is_summarised_like_any_message() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = hook_with(provider.clone(), 0);
    let note = goal_note();
    let note_text = note.content().unwrap().to_string();
    let mut state = AgentState::new(vec![note, ChatMessage::user("Redesign settings."), ChatMessage::assistant("Step 1 done.")], String::new());
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    assert!(summariser_request(&provider, 0).iter().any(|m| m.content().is_some_and(|c| c.contains(&note_text))), "the summariser did not read the goal note");
    assert!(!visible(&state, &note_text), "the summary replaces the goal note");
    assert!(!find(&state, &note_text).1.meta().pinned);
}

/// The goal note is compacted like any message, so the summary carries
/// an active goal's rules forward.
#[test]
fn summary_prompts_carry_an_active_goal_note_forward() {
    for key in ["summary_coding", "summary_chat"] {
        assert!(prompts::s(key).contains("`<session_goal>`"), "{key} does not carry the goal note");
    }
    assert!(prompts::s("runtime_notes").contains("`<session_goal>`"));
}

#[tokio::test]
async fn no_plan_file_adds_no_note_or_rule() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = hook_with(provider.clone(), 0).with_plan_dir(dir.path().to_path_buf());
    let state = compact_with(&hook, vec![ChatMessage::user("Hi."), ChatMessage::assistant("Hello.")]).await;
    assert!(plan_notes(&state).is_empty());
    assert!(!summariser_request(&provider, 0).last().unwrap().content().unwrap().contains(plan::PLAN_SUMMARY_RULE));
}

#[tokio::test]
async fn plan_note_still_in_the_kept_window_is_not_duplicated() {
    let dir = tempfile::tempdir().unwrap();
    save_plan(dir.path(), PLAN);
    let hook = hook(2).with_plan_dir(dir.path().to_path_buf());
    let state = compact_with(
        &hook,
        vec![
            ChatMessage::user("first"),
            ChatMessage::assistant("first reply"),
            ChatMessage::user("second"),
            ChatMessage::assistant("second reply"),
            plan_note(),
            ChatMessage::user("third"),
            ChatMessage::assistant("third reply"),
        ],
    )
    .await;
    let notes = plan_notes(&state);
    assert_eq!(notes.len(), 1, "the kept note is not restated again");
    assert!(!notes[0].1.meta().exclude_from_context);
}

/// A mid-turn compaction leaves the agent resuming from the summary
/// alone. A bare `## Goal…` user message reads like a new request, so
/// the model sees it framed as a handoff; the stored row (and the UI)
/// keep the plain summary.
#[tokio::test]
async fn the_model_sees_the_summary_framed_as_a_handoff() {
    let state = compact(0, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
    let stored = &state.messages[summary_index(&state)];
    assert_eq!(stored.content(), Some("Summary."), "the stored summary must stay unwrapped");

    let sent = state.messages_for_llm();
    let summary = sent.iter().find(|m| m.meta().is_summary()).expect("summary sent");
    let text = summary.content().unwrap();
    assert!(text.starts_with("<conversation_summary>\nSummary.\n</conversation_summary>\n"), "{text}");
    assert!(text.contains("not a new message from the user"), "{text}");
}

/// The summariser shares the main turn's prompt-cache prefix, so a prior
/// summary must reach it exactly as the main model saw it.
#[tokio::test]
async fn the_summariser_sees_a_prior_summary_as_the_main_model_did() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
    let hook = hook_with(provider.clone(), 0);
    let mut state = compact_with(&hook, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
    let main_view = state.messages_for_llm().into_iter().find(|m| m.meta().is_summary()).unwrap();
    state.messages.push(ChatMessage::user("Also fix logout."));
    state.messages.push(ChatMessage::assistant("On it."));
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    let request = summariser_request(&provider, 1);
    let prior = request.iter().find(|m| m.content().is_some_and(|c| c.contains("Summary one."))).expect("prior summary in request");
    // Consecutive user turns are merged, so the next request follows it.
    assert!(prior.content().unwrap().starts_with(main_view.content().unwrap()), "{:?}", prior.content());
}

/// The handoff needs the verbatim latest request (coding keeps no message
/// verbatim) and the user's open task list, which otherwise shrinks to a
/// one-line paraphrase and has to be pasted in again.
#[test]
fn coding_summary_template_keeps_sections_in_order() {
    let prompt = prompts::s("summary_coding");
    let headings = [
        "## Goal",
        "## Latest User Request",
        "## Constraints & Preferences",
        "## Progress",
        "### Done",
        "### In Progress",
        "### Blocked",
        "## Key Decisions",
        "## Next Steps",
        "## Open Work From the User",
        "## Critical Context",
        "## Relevant Files",
    ];
    let mut at = 0;
    for h in headings {
        let i = prompt[at..].find(&format!("\n{h}\n")).unwrap_or_else(|| panic!("{h} missing or out of order"));
        at += i + 1;
    }
    assert!(prompt.contains("Start your response with exactly `## Goal`."));
}

#[test]
fn plan_rule_keeps_plan_steps_out_of_open_work() {
    assert!(plan::PLAN_SUMMARY_RULE.contains("Open Work From the User"));
}

/// The summariser's final instruction: the only message the hint may change.
fn summary_instruction(provider: &MockProvider, call: usize) -> String {
    summariser_request(provider, call).last().unwrap().content().unwrap().to_string()
}

/// After a plan approval the newest user-role message is the Code-mode
/// note, and summaries quoted it (or the approval) as the user's latest
/// request; a retitle then named the session after it.
#[tokio::test]
async fn the_summariser_is_told_which_message_the_user_wrote() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = hook_with(provider.clone(), 0);
    compact_with(
        &hook,
        vec![ChatMessage::user("Plan the login fix."), ChatMessage::assistant("Plan submitted."), mode_note("code"), ChatMessage::assistant("Implementing step 1.")],
    )
    .await;

    let instruction = summary_instruction(&provider, 0);
    assert!(instruction.contains("<latest_user_message>\nPlan the login fix.\n</latest_user_message>"), "{instruction}");
    assert!(instruction.contains("`<interaction_mode>`"), "the runtime notes are named: {instruction}");
    // The hint rides on the final instruction only, so the conversation
    // before it still matches the main turn's prompt-cache prefix.
    let request = summariser_request(&provider, 0);
    assert!(!request[..request.len() - 1].iter().any(|m| m.content().is_some_and(|c| c.contains("latest_user_message"))));
}

#[tokio::test]
async fn a_goal_reminder_is_not_the_latest_request() {
    let mut reminder = ChatMessage::user("<goal_reminder turn=\"2\">\nKeep working.\n</goal_reminder>");
    let mut extra = Map::new();
    extra.insert("goal_turn".into(), json!({"turn": 2}));
    reminder.meta_mut().extra = Some(extra);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    compact_with(
        &hook_with(provider.clone(), 0),
        vec![ChatMessage::user("Make the tests pass."), ChatMessage::assistant("Ran tests."), reminder, ChatMessage::assistant("Fixed one.")],
    )
    .await;

    let instruction = summary_instruction(&provider, 0);
    assert!(instruction.contains("<latest_user_message>\nMake the tests pass.\n</latest_user_message>"), "{instruction}");
}

/// With no new message since the earlier note, the newest user-role
/// message is a runtime note; the request the note recorded stands.
#[tokio::test]
async fn no_new_prompt_since_the_prior_summary_keeps_its_request() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary one."), MockProvider::text("Summary two.")]));
    let hook = hook_with(provider.clone(), 0);
    let mut state = compact_with(&hook, vec![ChatMessage::user("Fix the login bug."), ChatMessage::assistant("Reading auth.rs.")]).await;
    state.messages.push(mode_note("code"));
    state.messages.push(ChatMessage::assistant("Editing auth.rs."));
    assert!(hook.summarise(&ctx(), &mut state, "sys").await);

    let instruction = summary_instruction(&provider, 1);
    assert!(!instruction.contains("<latest_user_message>"), "{instruction}");
    assert!(instruction.contains(NO_NEW_PROMPT_RULE), "{instruction}");
}

/// A message from another workspace's agent is the request of a session
/// it started; its model-only routing header is not part of it.
#[tokio::test]
async fn a_workspace_request_is_quoted_without_its_routing_header() {
    let mut sent = ChatMessage::user("Update the site for v3.30.");
    let mut extra = Map::new();
    extra.insert("sent_from".into(), json!({"session_id": "s1", "workspace": "/r/app", "workspace_name": "app", "reply": true}));
    sent.meta_mut().extra = Some(extra);
    let sent = crate::history::apply_llm_content_overrides(vec![sent]).remove(0);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    compact_with(&hook_with(provider.clone(), 0), vec![sent, ChatMessage::assistant("Updating.")]).await;

    let instruction = summary_instruction(&provider, 0);
    assert!(instruction.contains("<latest_user_message>\nUpdate the site for v3.30.\n</latest_user_message>"), "{instruction}");
}

/// An assistant reply carrying the usage its model call reported.
fn reply_with_usage(content: &str, prompt_tokens: i64) -> ChatMessage {
    let mut m = ChatMessage::assistant(content);
    let mut extra = Map::new();
    extra.insert("usage".into(), json!({"input": prompt_tokens, "output": 100}));
    m.meta_mut().extra = Some(extra);
    m
}

fn sent_max_tokens(provider: &MockProvider, call: usize) -> Option<i64> {
    provider.calls.lock().unwrap()[call].2.get("max_tokens").and_then(|v| v.as_i64())
}

/// Issue #425: a 262k-context model compacting a 246k-token history was
/// asked for a summary larger than the 15.4k tokens left in its context.
#[tokio::test]
async fn summary_budget_shrinks_to_the_room_left_in_the_context() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let mut hook = hook_with(provider.clone(), 0);
    hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
    hook.context_window = Some(262_144);
    let history = "x".repeat(700_000);
    compact_with(&hook, vec![ChatMessage::user(history), reply_with_usage("Done.", 246_735)]).await;

    let sent = sent_max_tokens(&provider, 0).expect("max_tokens sent");
    assert!(sent <= 262_144 - 246_735, "max_tokens {sent} does not fit the context");
    assert!(sent >= MIN_SUMMARY_TOKENS, "max_tokens {sent} leaves no room for a summary");
}

#[tokio::test]
async fn summary_budget_keeps_the_cap_when_the_context_has_room() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let mut hook = hook_with(provider.clone(), 0);
    hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
    hook.context_window = Some(262_144);
    compact_with(&hook, vec![ChatMessage::user("x".repeat(40_000)), reply_with_usage("Done.", 12_000)]).await;
    assert_eq!(sent_max_tokens(&provider, 0), Some(DEFAULT_MAX_TOKEN_LENGTH));
}

/// The reporter's model is not in the registry: a fixed cap could not be
/// checked against the room left, so the provider picks the budget.
#[tokio::test]
async fn unknown_context_window_sends_no_max_tokens() {
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let mut hook = hook_with(provider.clone(), 0);
    hook.max_token_length = DEFAULT_MAX_TOKEN_LENGTH;
    compact_with(&hook, vec![ChatMessage::user("Hi."), reply_with_usage("Hello.", 246_735)]).await;
    assert_eq!(sent_max_tokens(&provider, 0), None);
}

/// The retitle callback gets the session and its summary only when a
/// summary was written, with the newest message the user wrote.
#[tokio::test]
async fn on_summary_runs_only_after_a_successful_summary() {
    type Seen = Arc<Mutex<Vec<(String, String, Option<String>)>>>;
    let seen: Seen = Arc::default();
    let record = |seen: &Seen| -> OnSummary {
        let seen = seen.clone();
        Arc::new(move |sid: &str, text: &str, prompt: Option<&str>| seen.lock().unwrap().push((sid.into(), text.into(), prompt.map(String::from))))
    };
    let ctx = RunContext { session_id: Some("s-retitle".into()), ..ctx() };
    let history = || vec![ChatMessage::user("Fix the login page."), ChatMessage::assistant("Done."), mode_note("code")];

    let hook = hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")])), 0).with_on_summary(record(&seen));
    let mut state = AgentState::new(history(), String::new());
    assert!(hook.summarise(&ctx, &mut state, "sys").await);
    assert_eq!(*seen.lock().unwrap(), vec![("s-retitle".to_string(), "Summary.".to_string(), Some("Fix the login page.".to_string()))]);

    // An empty summary writes nothing and calls nothing.
    let hook = hook_with(Arc::new(MockProvider::new(vec![MockProvider::text("")])), 0).with_on_summary(record(&seen));
    let mut state = AgentState::new(history(), String::new());
    assert!(!hook.summarise(&ctx, &mut state, "sys").await);
    assert_eq!(seen.lock().unwrap().len(), 1);
}
