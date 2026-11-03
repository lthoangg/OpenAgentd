//! Appends LSP diagnostics to `patch`
//! results in coding workspaces.

use super::{Hook, RunContext, SharedMeta, ToolCallScope};
use appv3_providers::ToolCall;
use appv3_tools::denied::DeniedPaths;
use appv3_tools::patch::{parse_patch, Kind};
use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// Whether a tool result reads as a failure.
pub fn is_failed_result(result: &str) -> bool {
    if result.is_empty() {
        return true;
    }
    let stripped = result.trim_start_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c));
    let first = py_strip(stripped.split('\n').next().unwrap_or("")).to_lowercase();
    first.starts_with("error:")
        || first.starts_with("[failed")
        || first.starts_with("[error")
        || first.starts_with("[timed out")
        || first.contains("exit code 1")
        || first.contains("exit 1")
}

pub struct LspHook {
    pub enabled: bool,
    pub denied: Arc<DeniedPaths>,
}

impl LspHook {
    async fn diagnostics_report(&self, raw_args: &str) -> Result<Option<String>, String> {
        let args: Value = match serde_json::from_str(raw_args) {
            Ok(v) => v,
            Err(_) => {
                tracing::debug!("lsp_hook_skipped_unparseable_args tool=patch chars={}", raw_args.chars().count());
                return Ok(None);
            }
        };
        let Value::Object(args) = args else {
            return Ok(None);
        };
        let mut files: Vec<PathBuf> = vec![];
        match args.get("patch_text") {
            None | Some(Value::Null) => {}
            Some(Value::String(t)) if t.is_empty() => {}
            Some(Value::String(t)) => {
                let patches = parse_patch(t).map_err(|e| e.to_string())?;
                for p in patches {
                    if matches!(p.kind, Kind::Add | Kind::Update) {
                        let target = p.move_to.clone().filter(|m| !m.is_empty()).unwrap_or(p.path.clone());
                        files.push(self.denied.validate_path(&target).map_err(|e| e.to_string())?);
                    }
                }
            }
            Some(Value::Bool(false)) => {}
            Some(_) => return Err("expected string or bytes-like object".into()),
        }
        let mut unique: Vec<PathBuf> = vec![];
        for f in files {
            if !unique.contains(&f) {
                unique.push(f);
            }
        }
        let ws = self.denied.workspace_root.clone();
        let reports = futures::future::join_all(unique.iter().map(|f| appv3_tools::lsp::check_lsp_diagnostics(f, &ws))).await;
        let mut all_lines: Vec<String> = vec![];
        for r in reports.into_iter().flatten() {
            let mut lines: Vec<&str> = r.split('\n').collect();
            if lines.first() == Some(&"[LSP Diagnostics]") {
                lines.remove(0);
            }
            all_lines.extend(lines.into_iter().map(String::from));
        }
        if all_lines.is_empty() {
            return Ok(None);
        }
        Ok(Some(format!("[LSP Diagnostics]\n{}", all_lines.join("\n"))))
    }
}

#[async_trait]
impl Hook for LspHook {
    async fn after_tool(&self, _ctx: &RunContext, _meta: &SharedMeta, tc: &ToolCall, _scope: &mut ToolCallScope, result: &mut String) {
        if !self.enabled || tc.function.name != "patch" || is_failed_result(result) {
            return;
        }
        let raw = &tc.function.arguments;
        if raw.is_empty() {
            return;
        }
        match self.diagnostics_report(raw).await {
            Ok(Some(report)) => {
                result.push_str("\n\n");
                result.push_str(&report);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("Error in LspHook: {}", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_results() {
        assert!(is_failed_result(""));
        assert!(is_failed_result("  Error: nope"));
        assert!(is_failed_result("[Timed out after 3s]"));
        assert!(is_failed_result("done (exit code 1)\nmore"));
        assert!(!is_failed_result("Success. Updated the following files:\nM a.py"));
    }
}
