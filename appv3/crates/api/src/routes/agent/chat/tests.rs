use super::*;
use appv3_providers::mock::MockProvider;
use std::sync::Arc;

fn agent(thinking_level: Option<&str>) -> appv3_agent::Agent {
    let mut agent = appv3_agent::Agent::new(Arc::new(MockProvider::new(vec![])), "code", "Hi", vec![], Some("mock:mock".into()));
    agent.thinking_level = thinking_level.map(String::from);
    agent
}

#[test]
fn a_message_waits_behind_a_running_turn_and_a_held_one_behind_a_question() {
    // (busy, awaiting a question, held) -> queued
    assert!(waits_behind_turn(true, false, false), "a steer queues behind a running turn");
    assert!(waits_behind_turn(true, false, true));
    assert!(!waits_behind_turn(true, true, false), "a steer replaces an open question");
    assert!(waits_behind_turn(true, true, true), "a held message waits for the question to be answered");
    assert!(!waits_behind_turn(false, false, true), "an idle agent runs a held message at once");
}

#[test]
fn serialized_agent_carries_its_thinking_level() {
    let info = serialize_agent(&agent(Some("high")), None, None);
    assert_eq!(info["model"], "mock:mock");
    assert_eq!(info["thinking_level"], "high");
    assert_eq!(serialize_agent(&agent(None), None, None)["thinking_level"], Value::Null);
}

#[test]
fn serialized_agent_lists_preview_only_for_coding_workspaces() {
    let names = |info: &Value| info["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let dir = tempfile::tempdir().unwrap();
    let coding = serialize_agent(&agent(None), Some(&dir.path().to_string_lossy()), None);
    assert!(names(&coding).contains(&"preview".to_string()), "{coding}");
    assert!(!names(&serialize_agent(&agent(None), None, None)).contains(&"preview".to_string()));
}
