//! Every built-in tool in one table: who gets it, and whether Plan mode
//! allows it. The agent loader, member agents, sessions and Plan mode all
//! read it, so a tool is added here and nowhere else.
//!
//! Entry order is the order of the model's tools block (an agent's own
//! tools, then the ones a session adds), which opens the cached prompt
//! prefix: do not reorder entries.

use crate::loader::ProviderFactory;
use crate::session::AgentSession;
use appv3_db::DbPool;
use appv3_tools::{Tool, ToolRef};
use std::sync::{Arc, Weak};

/// Who gets a tool.
pub enum Offer {
    /// Every lead agent, ahead of the tools its file lists.
    Base(fn() -> ToolRef),
    /// An agent whose file lists it under `tools:`; a member agent only
    /// when `member` is set.
    Listed { make: fn() -> ToolRef, member: bool },
    /// Every lead agent while MCP is available, after its listed tools
    /// (the MCP source builds it).
    Mcp,
    /// Built for each turn of a session; `None` where it does not get it.
    Session(fn(&SessionCtx) -> Option<ToolRef>),
}

pub struct ToolEntry {
    pub name: &'static str,
    /// Plan mode lets the model call it. Some of these check each call
    /// themselves: `mcp` allows search, its server list and calls to
    /// read-only tools, `patch` writes only plan attachments under
    /// `.agents/plans/<folder>/`, `preview` only looks (no click, fill or
    /// press), and `workspace` only lists.
    pub plan_mode: bool,
    pub offer: Offer,
}

/// What a session-built tool draws on.
pub struct SessionCtx<'a> {
    pub sid: &'a str,
    pub agent_name: &'a str,
    pub workspace: &'a str,
    pub agent_mode: &'a str,
    /// The lead's session id, for a member's session.
    pub lead: Option<&'a str>,
    pub pool: &'a DbPool,
    pub provider_factory: &'a ProviderFactory,
    pub session: &'a Weak<AgentSession>,
}

impl SessionCtx<'_> {
    fn is_lead(&self) -> bool {
        self.lead.is_none()
    }
    /// A coding agent with a user workspace.
    fn coding(&self) -> bool {
        self.agent_mode == "coding" && !self.workspace.is_empty()
    }
}

fn some(t: impl Tool + 'static) -> Option<ToolRef> {
    Some(Arc::new(t))
}

pub static TOOLS: &[ToolEntry] = &[
    ToolEntry { name: "skill", plan_mode: true, offer: Offer::Base(|| Arc::new(crate::skills::SkillTool)) },
    ToolEntry { name: "todo", plan_mode: false, offer: Offer::Base(|| Arc::new(appv3_tools::todo::TodoTool)) },
    ToolEntry { name: "schedule", plan_mode: false, offer: Offer::Base(|| Arc::new(crate::scheduler::ScheduleTaskTool)) },
    ToolEntry { name: "read", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::read::ReadTool), member: true } },
    ToolEntry { name: "grep", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::grep::GrepTool), member: true } },
    ToolEntry { name: "glob", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::glob::GlobTool), member: true } },
    ToolEntry { name: "patch", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::patch::PatchTool), member: true } },
    ToolEntry { name: "shell", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::shell::ShellTool), member: true } },
    ToolEntry { name: "web_search", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::web::WebSearchTool), member: true } },
    ToolEntry { name: "web_fetch", plan_mode: true, offer: Offer::Listed { make: || Arc::new(appv3_tools::web::WebFetchTool), member: true } },
    ToolEntry { name: "generate_image", plan_mode: false, offer: Offer::Listed { make: || Arc::new(appv3_tools::multimodal::GenerateImageTool), member: false } },
    ToolEntry { name: "generate_video", plan_mode: false, offer: Offer::Listed { make: || Arc::new(appv3_tools::multimodal::GenerateVideoTool), member: false } },
    ToolEntry { name: "mcp", plan_mode: true, offer: Offer::Mcp },
    ToolEntry {
        name: "ask_user",
        plan_mode: true,
        offer: Offer::Session(|s| {
            if !s.is_lead() {
                return None;
            }
            some(crate::tools::ask_user::AskUserTool { session_id: s.sid.to_string(), pool: s.pool.clone(), agent_name: s.agent_name.to_string() })
        }),
    },
    ToolEntry {
        name: "team",
        plan_mode: true,
        offer: Offer::Session(|s| {
            if !s.is_lead() {
                return None;
            }
            some(crate::tools::team::DelegateTool { lead_session_id: s.sid.to_string(), pool: s.pool.clone(), provider_factory: s.provider_factory.clone() })
        }),
    },
    // Sessions without a user workspace keep the plan in the data dir.
    ToolEntry {
        name: "plan",
        plan_mode: true,
        offer: Offer::Session(|s| if s.is_lead() { some(crate::tools::plan::PlanTool { session_id: s.sid.to_string(), coding: s.coding(), pool: s.pool.clone() }) } else { None }),
    },
    ToolEntry {
        name: "update_goal",
        plan_mode: false,
        offer: Offer::Session(|s| if s.is_lead() { some(crate::tools::goal::UpdateGoalTool { session: s.session.clone() }) } else { None }),
    },
    ToolEntry { name: "preview", plan_mode: true, offer: Offer::Session(|s| if s.is_lead() && s.coding() { some(crate::tools::preview::PreviewTool) } else { None }) },
    ToolEntry {
        name: "ask_lead",
        plan_mode: false,
        offer: Offer::Session(|s| s.lead.and_then(|lead| some(crate::tools::team::AskLeadTool { lead_session_id: lead.to_string(), member_handle: s.agent_name.to_string() }))),
    },
    ToolEntry {
        name: "workspace",
        plan_mode: true,
        offer: Offer::Session(|s| {
            if !(s.is_lead() && appv3_core::runtime_settings::workspace_messages_enabled()) {
                return None;
            }
            some(crate::tools::workspace::WorkspaceTool::new(s.sid.to_string(), s.pool.clone()))
        }),
    },
];

fn entry(name: &str) -> Option<&'static ToolEntry> {
    TOOLS.iter().find(|e| e.name == name)
}

/// The tools every lead agent gets ahead of its listed ones, in order.
pub fn base_tools() -> impl Iterator<Item = &'static str> {
    TOOLS.iter().filter(|e| matches!(e.offer, Offer::Base(_))).map(|e| e.name)
}

/// Base and listed tools by name (what an agent file's `tools:` can name).
pub fn agent_tools() -> impl Iterator<Item = (&'static str, ToolRef)> {
    TOOLS.iter().filter_map(|e| match e.offer {
        Offer::Base(make) | Offer::Listed { make, .. } => Some((e.name, make())),
        _ => None,
    })
}

/// A tool a member agent gets when its file lists `name`.
pub fn member_tool(name: &str) -> Option<ToolRef> {
    match entry(name)?.offer {
        Offer::Listed { make, member: true } => Some(make()),
        _ => None,
    }
}

/// A tool the runtime gives agents itself: an agent file listing it is
/// left as it is, not pruned.
pub fn given_without_listing(name: &str) -> bool {
    entry(name).is_some_and(|e| !matches!(e.offer, Offer::Listed { .. }))
}

/// The tools a turn of this session adds to the agent's own, in order.
pub fn session_tools(ctx: &SessionCtx) -> Vec<ToolRef> {
    TOOLS
        .iter()
        .filter_map(|e| match e.offer {
            Offer::Session(make) => make(ctx),
            _ => None,
        })
        .collect()
}

/// Whether Plan mode lets the model call `name`.
pub fn allowed_in_plan_mode(name: &str) -> bool {
    entry(name).is_some_and(|e| e.plan_mode)
}

/// Every tool Plan mode allows.
pub fn plan_mode_tools() -> impl Iterator<Item = &'static str> {
    TOOLS.iter().filter(|e| e.plan_mode).map(|e| e.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_mode_allows_the_tools_it_always_allowed() {
        let mut allowed: Vec<&str> = plan_mode_tools().collect();
        allowed.sort();
        assert_eq!(allowed, ["ask_user", "glob", "grep", "mcp", "patch", "plan", "preview", "read", "shell", "skill", "team", "web_fetch", "web_search", "workspace"]);
        assert!(!allowed_in_plan_mode("todo") && !allowed_in_plan_mode("some_custom_tool"));
    }

    #[test]
    fn each_entry_builds_the_tool_it_names() {
        for (name, tool) in agent_tools() {
            assert_eq!(tool.name(), name);
        }
        let names: Vec<&str> = TOOLS.iter().map(|e| e.name).collect();
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "a tool is listed twice");
    }

    #[test]
    fn a_member_agent_can_list_only_the_file_and_web_tools() {
        let members: Vec<&str> = TOOLS.iter().map(|e| e.name).filter(|n| member_tool(n).is_some()).collect();
        assert_eq!(members, ["read", "grep", "glob", "patch", "shell", "web_search", "web_fetch"]);
    }

    #[test]
    fn an_agent_file_may_name_the_tools_the_runtime_gives_without_pruning() {
        for name in ["skill", "todo", "schedule", "mcp", "ask_user", "plan", "workspace"] {
            assert!(given_without_listing(name), "{name}");
        }
        assert!(!given_without_listing("read"));
        assert!(!given_without_listing("not_a_tool"));
    }
}
