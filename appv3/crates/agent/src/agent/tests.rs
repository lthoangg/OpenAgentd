use super::*;
use appv3_providers::{ChunkStream, Kwargs, ProviderResult, ToolSpec};
use std::path::Path;
use std::sync::Mutex;

#[test]
fn merged_question_calls_keep_non_ascii_text_verbatim() {
    let mut primary = ToolCall::new("a", "ask_user", r#"{"questions":[{"question":"Chọn màu?"}]}"#);
    let dup = ToolCall::new("b", "ask_user", r#"{"questions": [{"question": "Größe?"}]}"#);
    merge_question_calls(&mut primary, &[dup]);
    assert_eq!(primary.function.arguments, r#"{"questions":[{"question":"Chọn màu?"},{"question":"Größe?"}]}"#);
}

/// The user presses Stop while the model call is still waiting.
struct StoppedMidCall {
    stop: Event,
    calls: Mutex<usize>,
    kw: Kwargs,
}

#[async_trait::async_trait]
impl LlmProvider for StoppedMidCall {
    fn model(&self) -> &str {
        "mock"
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<AssistantMessage> {
        unreachable!("the loop streams")
    }
    async fn stream(&self, _: &[ChatMessage], _: Option<&[ToolSpec]>, _: &Kwargs) -> ProviderResult<ChunkStream> {
        *self.calls.lock().unwrap() += 1;
        self.stop.set();
        Ok(Box::pin(futures::stream::pending()))
    }
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A call cut short by Stop returns nothing, which once read as the
/// model answering empty: every Stop logged `agent_empty_response_retry`.
#[tokio::test]
async fn stop_during_a_model_call_is_not_an_empty_response() {
    let logs = Captured::default();
    let sink = logs.clone();
    let subscriber = tracing_subscriber::fmt().with_writer(move || sink.clone()).with_ansi(false).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let stop = Event::new();
    let provider = Arc::new(StoppedMidCall { stop: stop.clone(), calls: Mutex::new(0), kw: Kwargs::new() });
    let agent = Agent::new(provider.clone(), "code", "You help.", vec![], Some("mock:mock".into()));
    let root = tempfile::tempdir().unwrap();
    let opts = RunOptions {
        session_id: None,
        metadata: Map::new(),
        hooks: vec![],
        injected_tools: vec![],
        interrupt: Some(stop),
        hard_cancel: None,
        checkpointer: None,
        provider: None,
        model_id: None,
        denied: Arc::new(DeniedPaths::new(root.path(), None)),
        workspace: None,
    };

    agent.run(vec![ChatMessage::user("hi")], opts).await.unwrap();

    assert_eq!(*provider.calls.lock().unwrap(), 1);
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(!text.contains("agent_empty_response_retry"), "{text}");
    assert!(text.contains("agent_iteration_interrupted"), "{text}");
}

fn run_opts(root: &Path, interrupt: Option<Event>) -> RunOptions<'_> {
    RunOptions {
        session_id: None,
        metadata: Map::new(),
        hooks: vec![],
        injected_tools: vec![],
        interrupt,
        hard_cancel: None,
        checkpointer: None,
        provider: None,
        model_id: None,
        denied: Arc::new(DeniedPaths::new(root, None)),
        workspace: None,
    }
}

/// A response that ends the turn ("stop") with no text and no tool call.
fn empty_stop() -> appv3_providers::mock::MockTurn {
    use appv3_providers::{ChatCompletionChunk, ChatCompletionDelta, Usage};
    appv3_providers::mock::MockTurn::Chunks(vec![ChatCompletionChunk::delta(
        "mock",
        "mock",
        ChatCompletionDelta::default(),
        Some("stop".into()),
        Some(Usage { prompt_tokens: 10, completion_tokens: 14, total_tokens: 24, ..Default::default() }),
    )])
}

/// After a tool result the model kept answering empty; the turn used to
/// end with nothing shown and no error.
#[tokio::test(start_paused = true)]
async fn empty_answers_after_a_tool_end_the_turn_with_an_error() {
    use appv3_providers::mock::MockProvider;
    let provider = Arc::new(MockProvider::new(vec![MockProvider::tool_call("c1", "missing_tool", "{}"), empty_stop(), empty_stop(), empty_stop(), empty_stop()]));
    let agent = Agent::new(provider.clone(), "code", "You help.", vec![], Some("mock:mock".into()));
    let root = tempfile::tempdir().unwrap();

    let err = agent.run(vec![ChatMessage::user("check CI")], run_opts(root.path(), None)).await.unwrap_err();

    assert!(err.to_string().contains("empty response 4 times"), "{err}");
    assert_eq!(provider.calls.lock().unwrap().len(), 5);
}

#[tokio::test(start_paused = true)]
async fn empty_answer_retries_back_off() {
    use appv3_providers::mock::MockProvider;
    let provider = Arc::new(MockProvider::new(vec![MockProvider::tool_call("c1", "missing_tool", "{}"), empty_stop(), empty_stop(), MockProvider::text("CI is green.")]));
    let agent = Agent::new(provider.clone(), "code", "You help.", vec![], Some("mock:mock".into()));
    let root = tempfile::tempdir().unwrap();
    let start = tokio::time::Instant::now();

    agent.run(vec![ChatMessage::user("check CI")], run_opts(root.path(), None)).await.unwrap();

    // Two retries: 0.5 s, then 1 s.
    assert!(start.elapsed() >= Duration::from_millis(1500), "{:?}", start.elapsed());
    assert_eq!(provider.calls.lock().unwrap().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn stop_during_an_empty_answer_backoff_ends_the_turn() {
    use appv3_providers::mock::MockProvider;
    let provider = Arc::new(MockProvider::new(vec![MockProvider::tool_call("c1", "missing_tool", "{}"), empty_stop(), MockProvider::text("late")]));
    let agent = Agent::new(provider.clone(), "code", "You help.", vec![], Some("mock:mock".into()));
    let root = tempfile::tempdir().unwrap();
    let stop = Event::new();
    let s = stop.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        s.set();
    });

    agent.run(vec![ChatMessage::user("check CI")], run_opts(root.path(), Some(stop))).await.unwrap();

    assert_eq!(provider.calls.lock().unwrap().len(), 2);
}
