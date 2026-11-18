//! Running one tool call: hooks, Plan-mode and unattended refusals, plugin
//! wrappers, credential masking, OTEL spans, and the nested calls of `script`.

use super::{opens_confirm, round3, unattended_refusal, Agent, ToolRunResult, ASK_USER, SCRIPT, UNATTENDED_META, UNATTENDED_REASON_META};
use crate::hooks::{HookRef, RunContext, SharedMeta, ToolCallScope};
use crate::interaction_mode::tool_allowed_in_mode;
use appv3_providers::ToolCall;
use appv3_tools::{Suspension, ToolContext, ToolSet};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Most streamed output a cancelled call keeps (its tail), well under the
/// tool-result offload threshold.
const CANCELLED_OUTPUT_MAX_BYTES: usize = 16_384;

/// A dispatched call's progress, kept outside its future: when the user
/// stops the turn the future is dropped, and this is what is left of it.
#[derive(Default)]
pub(super) struct ToolProgress {
    started: Mutex<Option<Instant>>,
    /// Tail of the streamed output, and how many bytes fell off its front.
    output: Mutex<(String, usize)>,
}

impl ToolProgress {
    fn start(&self) {
        *self.started.lock().unwrap() = Some(Instant::now());
    }

    fn record(&self, text: &str) {
        let mut out = self.output.lock().unwrap();
        out.0.push_str(text);
        // Trim in batches; `cancelled` cuts to the exact size.
        if out.0.len() > 2 * CANCELLED_OUTPUT_MAX_BYTES {
            let cut = tail_start(&out.0, CANCELLED_OUTPUT_MAX_BYTES);
            out.0.drain(..cut);
            out.1 += cut;
        }
    }

    /// `(duration_ms, tool message)` for a call dropped by a stop: the
    /// output it streamed, then how long it ran. A call that never started
    /// (still queued for a slot) is just "Cancelled by user."
    pub(super) fn cancelled(&self) -> (Option<f64>, String) {
        let Some(started) = *self.started.lock().unwrap() else {
            return (None, "Cancelled by user.".into());
        };
        let elapsed = started.elapsed().as_secs_f64();
        let note = format!("Cancelled by user after {elapsed:.1} seconds.");
        let out = self.output.lock().unwrap();
        let cut = tail_start(&out.0, CANCELLED_OUTPUT_MAX_BYTES);
        let tail = out.0[cut..].trim_end();
        let omitted = out.1 + cut;
        let text = if tail.trim().is_empty() {
            note
        } else if omitted > 0 {
            format!("...output truncated ({omitted} bytes omitted)...\n{tail}\n\n{note}")
        } else {
            format!("{tail}\n\n{note}")
        };
        (Some(round3(elapsed * 1000.0)), text)
    }
}

/// Byte offset where the last `max` bytes of `s` start (on a char boundary).
pub(super) fn tail_start(s: &str, max: usize) -> usize {
    let mut cut = s.len().saturating_sub(max);
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    cut
}

impl Agent {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_tool(
        &self,
        ctx: &RunContext,
        meta: &SharedMeta,
        hooks: &[HookRef],
        tools: &ToolSet,
        base: &ToolContext,
        tc: &ToolCall,
        sem: &tokio::sync::Semaphore,
        progress: Option<&Arc<ToolProgress>>,
    ) -> Result<ToolRunResult, Suspension> {
        let _permit = sem.acquire().await.ok();
        let Some(o) = hooks.iter().find_map(|h| h.as_otel()) else {
            return self.run_tool_inner(ctx, meta, hooks, tools, base, tc, progress).await;
        };
        let span = o.start_tool_span(ctx, tc);
        let r = appv3_core::otel::scope(Some(span.ctx()), self.run_tool_inner(ctx, meta, hooks, tools, base, tc, progress)).await;
        use crate::hooks::otel::ToolOutcome;
        match &r {
            Ok(res) => o.end_tool_span(&span, ToolOutcome::Ok(&res.text)),
            Err(Suspension::Question { question_id, .. }) => {
                o.end_tool_span(&span, ToolOutcome::QuestionSuspended(&format!("Turn suspended awaiting user answer ({question_id})")))
            }
            Err(Suspension::Lead { question, .. }) => o.end_tool_span(&span, ToolOutcome::LeadSuspended(&format!("Turn suspended awaiting lead answer: {question}"))),
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_tool_inner(
        &self,
        ctx: &RunContext,
        meta: &SharedMeta,
        hooks: &[HookRef],
        tools: &ToolSet,
        base: &ToolContext,
        tc: &ToolCall,
        progress: Option<&Arc<ToolProgress>>,
    ) -> Result<ToolRunResult, Suspension> {
        if let Some(p) = progress {
            p.start();
        }
        let mut scope = ToolCallScope { ui_id: tc.id.clone(), started: Instant::now(), output: None, duration_ms: None, mcp_app: None };
        for h in hooks {
            if let Err(text) = h.before_tool(ctx, meta, tc, &mut scope).await {
                return Ok(ToolRunResult { text: format!("Error: {text}"), parts: None, mcp_app: None, duration_ms: None });
            }
        }
        // Tee streamed output into the progress record, so a stop mid-call
        // still reports what the tool printed.
        if let Some(p) = progress.cloned() {
            let sink = scope.output.take();
            scope.output = Some(Arc::new(move |text: String| {
                p.record(&text);
                if let Some(sink) = &sink {
                    sink(text);
                }
            }));
        }
        let live_mask = crate::tool_mask::LiveMask::wrap(&mut scope.output); // stored credentials never leave a call
        let mode = meta.lock().unwrap().get("interaction_mode").and_then(|v| v.as_str()).map(String::from);
        let unattended = meta.lock().unwrap().get(UNATTENDED_META).and_then(Value::as_bool).unwrap_or(false);
        let unattended_reason = meta.lock().unwrap().get(UNATTENDED_REASON_META).and_then(Value::as_str).map(String::from);
        let exec = |call: ToolCall| {
            let mut tctx = base.clone();
            tctx.tool_call_id = call.id.clone();
            tctx.output = scope.output.clone();
            let mode = mode.clone();
            let unattended_reason = unattended_reason.clone();
            async move {
                match mode {
                    // `plan` handles its own unattended submit (it still saves).
                    _ if unattended && call.function.name == ASK_USER => Ok((unattended_refusal(&call.function.name, unattended_reason.as_deref()), (None, None))),
                    _ if unattended && opens_confirm(&call) => Ok((unattended_refusal(&call.function.name, unattended_reason.as_deref()), (None, None))),
                    Some(m) if !tool_allowed_in_mode(&m, &call.function.name) => Ok((format!("Error: Tool '{}' is unavailable in Plan mode.", call.function.name), (None, None))),
                    _ if call.function.name == SCRIPT => {
                        // The script's nested calls come back through this loop.
                        let runner = self.nested_runner(ctx, meta, hooks, tools, &tctx, &call.id);
                        let out = crate::tools::script::NESTED.scope(runner, appv3_tools::execute(tools, &tctx, &call.function.name, &call.function.arguments)).await?;
                        Ok::<_, Suspension>((crate::tool_mask::masked(out.text), (out.parts, out.mcp_app)))
                    }
                    _ => {
                        let out = appv3_tools::execute(tools, &tctx, &call.function.name, &call.function.arguments).await?;
                        Ok::<_, Suspension>((crate::tool_mask::masked(out.text), (out.parts, out.mcp_app)))
                    }
                }
            }
        };
        // Single-file plugins' hooks wrap first, then the plugin bundles'.
        let bundled = crate::plugins::bundle_tool_hooks();
        let plugins: std::borrow::Cow<[crate::plugins::ToolPluginRef]> = if bundled.is_empty() {
            std::borrow::Cow::Borrowed(crate::plugins::tool_plugins())
        } else {
            std::borrow::Cow::Owned(crate::plugins::tool_plugins().iter().cloned().chain(bundled).collect())
        };
        let (mut text, (parts, mut mcp_app)) = if plugins.is_empty() {
            exec(tc.clone()).await?
        } else {
            let pctx =
                crate::plugins::PluginCtx { tool: &tc.function.name, session_id: ctx.session_id.as_deref(), run_id: &ctx.run_id, agent_name: &ctx.agent_name, call_id: &tc.id };
            crate::plugins::wrap_tool_call(&plugins, pctx, tc, exec).await?
        };
        live_mask.finish();
        text = crate::tool_mask::masked(text); // a plugin's wrapper may have added output
                                               // The app's page is kept once on disk, not in every result and event.
        if let Some(app) = mcp_app.as_mut() {
            crate::mcp_apps::store_html(app).await;
        }
        scope.mcp_app = mcp_app.clone();
        for h in hooks.iter().rev() {
            h.after_tool(ctx, meta, tc, &mut scope, &mut text).await;
        }
        Ok(ToolRunResult { text, parts, mcp_app, duration_ms: scope.duration_ms })
    }

    /// Runs the nested calls of `script` call `parent_id` like direct calls
    /// (Plan mode, unattended refusals, plugin hooks, OTEL spans), with the
    /// hooks that suit a nested call: no transcript rows, no offloading.
    fn nested_runner(&self, ctx: &RunContext, meta: &SharedMeta, hooks: &[HookRef], tools: &ToolSet, base: &ToolContext, parent_id: &str) -> appv3_jsplugin::script::HostCallFn {
        struct Env {
            agent: Agent,
            ctx: RunContext,
            meta: SharedMeta,
            hooks: Vec<HookRef>,
            /// Every hook, told when each nested call ends.
            all_hooks: Vec<HookRef>,
            tools: ToolSet,
            base: ToolContext,
            sem: tokio::sync::Semaphore,
            parent: String,
            seq: std::sync::atomic::AtomicUsize,
        }
        let mut base = base.clone();
        base.output = None;
        let env = Arc::new(Env {
            agent: self.clone(),
            ctx: ctx.clone(),
            meta: meta.clone(),
            hooks: hooks.iter().filter(|h| h.wraps_nested_calls()).cloned().collect(),
            all_hooks: hooks.to_vec(),
            tools: tools.clone(),
            base,
            sem: tokio::sync::Semaphore::new(crate::tools::script::MAX_CONCURRENT_NESTED),
            parent: parent_id.to_string(),
            seq: Default::default(),
        });
        Arc::new(move |name: String, args: Value| -> appv3_jsplugin::script::HostFuture {
            let env = env.clone();
            Box::pin(async move {
                let n = env.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let tc = ToolCall::new(format!("{}.{n}", env.parent), name, args.to_string());
                let r = env.agent.run_tool(&env.ctx, &env.meta, &env.hooks, &env.tools, &env.base, &tc, &env.sem, None).await;
                if r.is_ok() {
                    for h in &env.all_hooks {
                        h.after_nested_tool(&env.ctx, &tc).await;
                    }
                }
                match r {
                    Ok(r) if crate::hooks::lsp::is_failed_result(&r.text) => Err(r.text.trim_start().strip_prefix("Error:").unwrap_or(&r.text).trim().to_string()),
                    Ok(r) => Ok(r.text),
                    Err(_) => Err("the call paused for an answer, which a script cannot give".to_string()),
                }
            })
        })
    }
}
