//! The lead reaches MCP servers through one `mcp` tool, attached whenever a
//! server is configured, instead of one tool per server tool. Lives in its
//! own test binary because the MCP source is a process-wide slot.

use appv3_agent::loader::{self, McpSource, ProviderFactory};
use appv3_providers::LlmProvider;
use appv3_tools::{Tool, ToolContext, ToolOutput, ToolRef, ToolResult};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

struct FakeHub;

#[async_trait]
impl Tool for FakeHub {
    fn name(&self) -> &str {
        "mcp"
    }
    async fn run(&self, _ctx: &ToolContext, _args: Value) -> ToolResult {
        Ok(ToolOutput::text("ok"))
    }
}

struct FakeSource(Vec<String>);

impl McpSource for FakeSource {
    fn server_names(&self) -> Vec<String> {
        self.0.clone()
    }
    fn tools_for_server(&self, _name: &str) -> Vec<ToolRef> {
        vec![]
    }
    fn hub_tool(&self) -> ToolRef {
        Arc::new(FakeHub)
    }
}

#[test]
fn lead_gets_one_mcp_tool_when_servers_are_configured() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("code.md");
    std::fs::write(&p, "---\nname: code\nmodel: openai:gpt-5\ntools:\n- read\n- mcp\n- docs_search\n---\n\nHi\n").unwrap();
    let factory: ProviderFactory = Arc::new(|_, _| Ok(Arc::new(appv3_providers::mock::MockProvider::new(vec![])) as Arc<dyn LlmProvider>));

    loader::set_mcp_source(Arc::new(FakeSource(vec![])));
    let agent = loader::rebuild_agent_from_disk(&p, &factory).unwrap();
    assert!(!agent.tools.contains("mcp"), "no servers, no mcp tool");
    assert!(agent.mcp_servers.is_empty());

    loader::set_mcp_source(Arc::new(FakeSource(vec!["docs".into(), "github".into()])));
    let agent = loader::rebuild_agent_from_disk(&p, &factory).unwrap();
    let names = agent.tools.names();
    assert_eq!(names.iter().filter(|n| *n == "mcp").count(), 1, "{names:?}");
    assert!(!names.iter().any(|n| n.starts_with("docs_")), "{names:?}");
    assert_eq!(agent.mcp_servers, vec!["docs", "github"]);
    assert!(!loader::default_tool_registry().contains_key("mcp"));

    // `mcp` listed in `tools:` is kept; an old `<server>_<tool>` name is pruned.
    let text = std::fs::read_to_string(&p).unwrap();
    assert!(text.contains("- mcp") && !text.contains("docs_search"), "{text}");
}
