//! Small hooks: current date, workspace instructions, runtime protocol,
//! memory context, tool-result offload, queued-message injection.

use super::{AgentState, Hook, ModelRequest, RunContext, SharedMeta, ToolCallScope};
use crate::events::Envelope;
use crate::prompts;
use crate::stream_store::store;
use crate::util::{head_chars, tail_chars};
use appv3_db::DbPool;
use appv3_providers::ToolCall;
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ── inject_current_date ─────────────────────────────────────────────────────

pub struct CurrentDateHook;

#[async_trait]
impl Hook for CurrentDateHook {
    async fn wrap_system_prompt(&self, _ctx: &RunContext, _state: &AgentState, prompt: String) -> String {
        format!("{prompt}\n\nCurrent date (UTC): {}", chrono::Utc::now().format("%Y-%m-%d"))
    }
}

// ── WorkspaceInstructionsHook ────────────────────────────────────────────────

pub const MAX_AGENTS_MD_BYTES: u64 = 128 * 1024;

/// The global instructions file: `~/.agents/AGENTS.md`, shared by every
/// workspace. `{config dir}/AGENTS.md` is the older location, read only
/// when the home file does not exist.
pub fn global_instructions_path() -> PathBuf {
    if let Some(home) = appv3_core::home::home_dir_opt() {
        let u = home.join(".agents").join("AGENTS.md");
        if u.is_file() {
            return u;
        }
    }
    appv3_core::settings().config_dir.join("AGENTS.md")
}

/// Modification stamp used to invalidate a cached instructions file.
type FileStamp = (u128, u64, u64);

pub struct WorkspaceInstructionsHook {
    workspace: Option<PathBuf>,
    /// False only in Chat sessions, which have no project instructions.
    include_workspace: bool,
    global: PathBuf,
    cache: Mutex<HashMap<PathBuf, (FileStamp, String)>>,
}

impl WorkspaceInstructionsHook {
    pub fn new(workspace: Option<&str>, include_workspace: bool) -> Self {
        let workspace = workspace.filter(|w| !w.is_empty()).map(|w| appv3_tools::denied::resolve(Path::new(w)));
        Self { workspace, include_workspace, global: global_instructions_path(), cache: Mutex::new(HashMap::new()) }
    }

    fn read_file(&self, path: &Path) -> String {
        let Ok(md) = std::fs::metadata(path) else {
            self.cache.lock().unwrap().remove(path);
            return String::new();
        };
        if !md.is_file() {
            self.cache.lock().unwrap().remove(path);
            return String::new();
        }
        let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        #[cfg(unix)]
        let ino = std::os::unix::fs::MetadataExt::ino(&md);
        #[cfg(not(unix))]
        let ino = 0u64;
        let sig = (mtime, md.len(), ino);
        if let Some((s, text)) = self.cache.lock().unwrap().get(path) {
            if *s == sig {
                return text.clone();
            }
        }
        let text = if md.len() > MAX_AGENTS_MD_BYTES {
            tracing::warn!("workspace_instructions_file_too_large path={} bytes={} limit={}", path.display(), md.len(), MAX_AGENTS_MD_BYTES);
            String::new()
        } else {
            match std::fs::read_to_string(path) {
                Ok(t) => t.trim().to_string(),
                Err(e) => {
                    tracing::warn!("workspace_instructions_file_read_failed path={} error={}", path.display(), e);
                    return String::new();
                }
            }
        };
        self.cache.lock().unwrap().insert(path.to_path_buf(), (sig, text.clone()));
        text
    }
}

#[async_trait]
impl Hook for WorkspaceInstructionsHook {
    async fn wrap_system_prompt(&self, _ctx: &RunContext, _state: &AgentState, prompt: String) -> String {
        let mut blocks = Vec::new();
        if let Some(ws) = &self.workspace {
            // Here rather than in a built-in prompt: those are written once
            // and then user-owned, so a change there never reaches existing
            // installs. The UI links code spans holding a path.
            let mut block = format!(
                "## Workspace\nRoot: `{}`\nCite a file by its path from this root, in backticks, adding `:line` or `:start-end` to point at code (e.g. `web/src/app.ts:42-58`).",
                ws.display()
            );
            if !self.include_workspace {
                // Chat runs the coding prompt too.
                block.push_str("\nThis is a Chat session, not a project: help with whatever the user asks. The root is the user's Chat folder (by default their home directory), not a repository to explore, test, or follow conventions for, unless the user points you at files in it.");
            }
            blocks.push(block);
        }
        let global = self.read_file(&self.global);
        if !global.is_empty() {
            blocks.push(format!("## Global Instructions\n\nSource: `{}`\n\n{global}", self.global.display()));
        }
        if self.include_workspace {
            if let Some(ws) = &self.workspace {
                for f in ["AGENTS.md", ".agents/AGENTS.md"] {
                    let path = ws.join(f);
                    // A workspace at `~` would otherwise repeat the global file.
                    if same_file(&path, &self.global) {
                        continue;
                    }
                    let t = self.read_file(&path);
                    if !t.is_empty() {
                        blocks.push(format!("## Workspace Instructions\n\n{t}"));
                        break;
                    }
                }
            }
        }
        if blocks.is_empty() {
            return prompt;
        }
        let block = blocks.join("\n\n");
        if prompt.is_empty() {
            block
        } else {
            format!("{prompt}\n\n{block}")
        }
    }
}

fn append_block(prompt: &mut String, block: &str) {
    if block.is_empty() {
        return;
    }
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str(block);
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

// ── RuntimeProtocolHook ──────────────────────────────────────────────────────

/// Appends the runtime protocol (instruction sources, secrets, workspace and
/// git safety) to every agent. It lives here, not in the built-in prompt,
/// because an agent file's own prompt replaces that prompt entirely.
pub struct RuntimeProtocolHook;

#[async_trait]
impl Hook for RuntimeProtocolHook {
    async fn before_agent(&self, _ctx: &RunContext, state: &mut AgentState) {
        append_block(&mut state.system_prompt, prompts::runtime_protocol());
    }
}

// ── MemoryContextHook ────────────────────────────────────────────────────────

/// Appends the memory rules and the rendered `<openagentd_memory>` block
/// (computed by the session). The lead saves memory; delegated agents only
/// read it, since their "user" is the lead rather than the person.
pub struct MemoryContextHook {
    pub content: String,
    pub lead: bool,
}

#[async_trait]
impl Hook for MemoryContextHook {
    async fn before_agent(&self, _ctx: &RunContext, state: &mut AgentState) {
        // The rules are unconditional: with no pages yet the lead still has
        // to learn it may create the first one.
        append_block(&mut state.system_prompt, prompts::memory_protocol(self.lead));
        if !self.content.is_empty() {
            append_block(&mut state.system_prompt, &self.content);
        }
    }
}

// ── ToolResultOffloadHook ────────────────────────────────────────────────────

pub const DEFAULT_CHAR_THRESHOLD: usize = 40_000;
pub const DEFAULT_PREVIEW_CHARS: usize = 1000;

pub struct ToolResultOffloadHook {
    pub char_threshold: usize,
    pub preview_chars: usize,
}

impl Default for ToolResultOffloadHook {
    fn default() -> Self {
        Self { char_threshold: DEFAULT_CHAR_THRESHOLD, preview_chars: DEFAULT_PREVIEW_CHARS }
    }
}

/// Python `f"{n:,}"`.
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[async_trait]
impl Hook for ToolResultOffloadHook {
    async fn after_tool(&self, ctx: &RunContext, meta: &SharedMeta, tc: &ToolCall, _scope: &mut ToolCallScope, result: &mut String) {
        let chars = result.chars().count();
        let name = tc.function.name.as_str();
        if self.char_threshold == 0 || chars <= self.char_threshold || name == "read" || name == "skill" {
            return;
        }
        let tc_id = if tc.id.is_empty() { format!("tc_{name}") } else { tc.id.clone() };
        let dir = appv3_tools::denied::session_artifacts_dir(ctx.session_id.as_deref()).join(".tool_results").join(&ctx.agent_name);
        let digest = Sha256::digest(tc_id.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let dest = dir.join(format!("{hex}.txt"));
        let write = std::fs::create_dir_all(&dir).and_then(|_| appv3_core::secret_files::write_secret_file(&dest, result));
        if let Err(e) = write {
            tracing::warn!("tool_result_offload_write_failed agent={} tool={} tool_call_id={} error={}", ctx.agent_name, name, tc_id, e);
            return;
        }
        let lines = result.matches('\n').count() + 1;
        let p = self.preview_chars;
        let head = head_chars(result, p).trim_end().to_string();
        let tail = if chars > p * 2 { tail_chars(result, p).trim_start().to_string() } else { String::new() };
        let omitted = if !tail.is_empty() { chars - p * 2 } else { chars.saturating_sub(p) };
        let path = dest.display().to_string();
        let mut compact = format!(
            "[Tool result offloaded — content saved to session artifacts]\nFile: {path}\nSize: {} lines · {} chars\n\nPreview (first):\n{head}",
            thousands(lines),
            thousands(chars)
        );
        if !tail.is_empty() {
            compact.push_str(&format!("\n… ({} chars omitted)\n\nPreview (last):\n{tail}", thousands(omitted)));
        } else if chars > p {
            compact.push_str(&format!("\n… ({} more chars — use read to load full output)", thousands(omitted)));
        }
        tracing::info!("tool_result_offloaded agent={} tool={} tool_call_id={} chars={} path={}", ctx.agent_name, name, tc_id, chars, path);
        let mut m = meta.lock().unwrap();
        let entry = m.entry("_offloaded_tool_results").or_insert_with(|| json!({}));
        if let Some(o) = entry.as_object_mut() {
            o.insert(tc_id, json!({"offloaded": true, "path": path, "lines": lines, "chars": chars}));
        }
        drop(m);
        *result = compact;
    }
}

// ── QueuedMessageInjectionHook ───────────────────────────────────────────────

pub struct QueuedInjectionHook {
    pub session_id: String,
    pub agent_name: String,
    pub pool: DbPool,
    pub support_interrupt: bool,
}

#[async_trait]
impl Hook for QueuedInjectionHook {
    async fn before_model(&self, _ctx: &RunContext, state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        if !self.support_interrupt || appv3_db::codec::parse_uuid(&self.session_id).is_none() {
            return None;
        }
        let queued = match crate::snapshot::release_queued(&self.pool, &self.session_id).await {
            Ok(q) if !q.is_empty() => q,
            Ok(_) => return None,
            Err(e) => {
                tracing::warn!("queued_injection_failed error={}", e);
                return None;
            }
        };
        // Every released row, so each steer arrives with its @-mention context.
        state.messages.extend(crate::history::rows_to_llm_messages(queued.clone()));
        state.meta_pop("question_resume");
        // The UI shows only what the user wrote.
        let visible: Vec<&appv3_db::SessionMessage> = queued.iter().filter(|r| !appv3_db::is_attached_row(r)).collect();
        let ids: Vec<String> = visible.iter().map(|r| appv3_db::codec::api_uuid(&r.id)).collect();
        let data: Vec<Value> =
            visible.iter().map(|r| json!({"id": appv3_db::codec::api_uuid(&r.id), "content": r.content.clone().unwrap_or_default(), "extra": r.extra_json()})).collect();
        store().push_event(
            &self.session_id,
            &Envelope::from_parts("queued_turn_start", json!({"type": "queued_turn_start", "agent": self.agent_name, "message_ids": ids, "messages": data})),
            false,
        );
        tracing::info!("queued_messages_injected session_id={} count={}", self.session_id, ids.len());
        Some(ModelRequest { messages: state.messages_for_llm(), system_prompt: _req.system_prompt.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The UI links a cited file only when it can find it; a path from the
    /// root is the one form it never has to guess at.
    #[tokio::test]
    async fn workspace_block_asks_for_file_paths_from_the_root() {
        let hook = WorkspaceInstructionsHook {
            workspace: Some(PathBuf::from("/repo")),
            include_workspace: false,
            global: PathBuf::from("/nonexistent/AGENTS.md"),
            cache: Mutex::new(HashMap::new()),
        };
        let ctx = RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None };
        let state = AgentState::new(Vec::new(), String::new());

        let prompt = hook.wrap_system_prompt(&ctx, &state, "Base.".into()).await;

        assert!(prompt.starts_with("Base.\n\n## Workspace\nRoot: `/repo`\n"), "{prompt}");
        assert!(prompt.contains("path from this root"), "{prompt}");
        assert!(prompt.contains("`:line` or `:start-end`"), "{prompt}");
        assert!(prompt.contains("`web/src/app.ts:42-58`"), "{prompt}");
    }

    /// Chat sessions run the same coding prompt, so the block says there is
    /// no project to explore, test, or follow conventions for.
    #[tokio::test]
    async fn chat_workspace_block_says_no_project_is_attached() {
        let hook = |include_workspace| WorkspaceInstructionsHook {
            workspace: Some(PathBuf::from("/chat")),
            include_workspace,
            global: PathBuf::from("/nonexistent/AGENTS.md"),
            cache: Mutex::new(HashMap::new()),
        };
        let ctx = RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None };
        let state = AgentState::new(Vec::new(), String::new());

        let chat = hook(false).wrap_system_prompt(&ctx, &state, "Base.".into()).await;
        let project = hook(true).wrap_system_prompt(&ctx, &state, "Base.".into()).await;

        assert!(chat.contains("This is a Chat session, not a project"), "{chat}");
        assert!(!project.contains("Chat session"), "{project}");
    }

    /// With the workspace at `~`, `~/.agents/AGENTS.md` is the global file
    /// and must not come back a second time as workspace instructions.
    #[tokio::test]
    async fn home_workspace_does_not_repeat_the_global_file() {
        let home = tempfile::tempdir().unwrap();
        let global = home.path().join(".agents").join("AGENTS.md");
        std::fs::create_dir_all(global.parent().unwrap()).unwrap();
        std::fs::write(&global, "Global rule.").unwrap();
        let hook = WorkspaceInstructionsHook { workspace: Some(home.path().to_path_buf()), include_workspace: true, global, cache: Mutex::new(HashMap::new()) };
        let ctx = RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None };
        let state = AgentState::new(Vec::new(), String::new());

        let prompt = hook.wrap_system_prompt(&ctx, &state, String::new()).await;

        assert_eq!(prompt.matches("Global rule.").count(), 1, "{prompt}");
        assert!(!prompt.contains("## Workspace Instructions"), "{prompt}");
    }
}
