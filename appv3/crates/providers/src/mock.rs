//! Scripted provider for unit tests (not reachable from the factory).

use crate::types::*;
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::Mutex;

/// Arguments recorded for one `stream` call: messages, tools, kwargs.
pub type MockCall = (Vec<ChatMessage>, Option<Vec<ToolSpec>>, Kwargs);

/// One scripted turn: a list of chunks, an error raised before streaming, or
/// a stream that never yields (a request that hangs until it is dropped).
pub enum MockTurn {
    Chunks(Vec<ChatCompletionChunk>),
    Error(ProviderError),
    Hang,
}

pub struct MockProvider {
    pub turns: Mutex<VecDeque<MockTurn>>,
    pub calls: Mutex<Vec<MockCall>>,
    kw: Kwargs,
    pub model: String,
}

impl MockProvider {
    pub fn new(turns: Vec<MockTurn>) -> Self {
        Self { turns: Mutex::new(turns.into()), calls: Mutex::new(vec![]), kw: Kwargs::new(), model: "mock".into() }
    }

    pub fn text(text: &str) -> MockTurn {
        MockTurn::Chunks(vec![
            ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { content: Some(text.into()), ..Default::default() }, None, None),
            ChatCompletionChunk::delta(
                "mock",
                "mock",
                ChatCompletionDelta::default(),
                Some("stop".into()),
                Some(Usage { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, ..Default::default() }),
            ),
        ])
    }

    pub fn tool_call(id: &str, name: &str, args: &str) -> MockTurn {
        Self::tool_calls(&[(id, name, args)])
    }

    /// A request that never answers.
    pub fn hang() -> MockTurn {
        MockTurn::Hang
    }

    /// One response making several tool calls: `(id, name, arguments)`.
    pub fn tool_calls(calls: &[(&str, &str, &str)]) -> MockTurn {
        let deltas = calls
            .iter()
            .enumerate()
            .map(|(i, (id, name, args))| ToolCallDelta {
                index: Some(i as _),
                id: Some((*id).into()),
                function: Some(FunctionCallDelta { name: Some((*name).into()), arguments: Some((*args).into()), ..Default::default() }),
            })
            .collect();
        MockTurn::Chunks(vec![
            ChatCompletionChunk::delta("mock", "mock", ChatCompletionDelta { tool_calls: Some(deltas), ..Default::default() }, None, None),
            ChatCompletionChunk::delta(
                "mock",
                "mock",
                ChatCompletionDelta::default(),
                Some("tool_calls".into()),
                Some(Usage { prompt_tokens: 15, completion_tokens: 30, total_tokens: 45, ..Default::default() }),
            ),
        ])
    }
}

#[async_trait]
impl LlmProvider for MockProvider {
    fn model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> Option<&str> {
        Some("mock")
    }
    fn base_kwargs(&self) -> &Kwargs {
        &self.kw
    }
    async fn chat(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<AssistantMessage> {
        self.calls.lock().unwrap().push((messages.to_vec(), tools.map(|t| t.to_vec()), kwargs.clone()));
        let turn = self.turns.lock().unwrap().pop_front();
        match turn {
            Some(MockTurn::Chunks(chunks)) => {
                let content: String = chunks.iter().flat_map(|c| c.choices.iter()).filter_map(|c| c.delta.content.clone()).collect();
                Ok(AssistantMessage { content: Some(content).filter(|s| !s.is_empty()), ..Default::default() })
            }
            Some(MockTurn::Error(e)) => Err(e),
            Some(MockTurn::Hang) => std::future::pending().await,
            None => Ok(AssistantMessage { content: Some("mock".into()), ..Default::default() }),
        }
    }
    async fn stream(&self, messages: &[ChatMessage], tools: Option<&[ToolSpec]>, kwargs: &Kwargs) -> ProviderResult<ChunkStream> {
        self.calls.lock().unwrap().push((messages.to_vec(), tools.map(|t| t.to_vec()), kwargs.clone()));
        let turn = self.turns.lock().unwrap().pop_front();
        match turn {
            Some(MockTurn::Chunks(chunks)) => Ok(Box::pin(futures::stream::iter(chunks.into_iter().map(Ok)))),
            Some(MockTurn::Error(e)) => Err(e),
            Some(MockTurn::Hang) => Ok(Box::pin(futures::stream::pending())),
            None => {
                let MockTurn::Chunks(c) = Self::text("mock") else { unreachable!() };
                Ok(Box::pin(futures::stream::iter(c.into_iter().map(Ok))))
            }
        }
    }
}
