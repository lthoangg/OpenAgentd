//! `agentd run`: one agent turn in a workspace, streamed to stdout.
//!
//! Text mode prints the lead agent's reply. `--json` prints one
//! `{"event": …, "data": …}` line per stream event, starting with the
//! `session` event that carries the session id.

use crate::cli::RunArgs;
use anyhow::{anyhow, bail, Context, Result};
use appv3_agent::{events, manager, service, stream_store};
use serde_json::Value;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;

fn normalized(v: Option<&str>) -> Option<String> {
    v.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// One NDJSON line; `data` is embedded as JSON (a string if it is not).
fn json_line(event: &str, data: &str) -> String {
    let data = serde_json::from_str::<Value>(data).unwrap_or_else(|_| Value::String(data.into()));
    serde_json::json!({"event": event, "data": data}).to_string()
}

/// `(workspace, session id)` for `--session`, `--continue`, or a new session.
async fn pick_session(pool: &appv3_db::DbPool, args: &RunArgs) -> Result<(String, String)> {
    if let Some(id) = args.session.as_deref() {
        let s = appv3_db::get_session(pool, id).await?.ok_or_else(|| anyhow!("session not found: {id}"))?;
        let workspace = manager::validate_workspace(&s.workspace, true).map_err(|e| anyhow!(e))?;
        return Ok((workspace, appv3_db::codec::api_uuid(&s.id)));
    }
    let cwd = std::env::current_dir().context("read the current directory")?;
    let dir: PathBuf = match &args.cd {
        Some(d) if d.is_absolute() => d.clone(),
        Some(d) => cwd.join(d),
        None => cwd,
    };
    let workspace = manager::validate_workspace(&dir.display().to_string(), true).map_err(|e| anyhow!(e))?;
    let latest = if args.continue_session { appv3_db::get_latest_top_level_session(pool, &workspace).await? } else { None };
    let id = latest.map(|s| appv3_db::codec::api_uuid(&s.id)).unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    Ok((workspace, id))
}

async fn run_turn(args: &RunArgs) -> Result<()> {
    if args.prompt.trim().is_empty() {
        bail!("--prompt must not be blank");
    }
    let model = normalized(args.model.as_deref());
    let thinking = normalized(args.thinking.as_deref());
    if let Some(m) = &model {
        if !appv3_api::providers::is_registered_model_id(m) {
            bail!("unknown model {m:?}; choose a model from the registry");
        }
    }
    appv3_api::startup::ensure_workspace_initialized()?;
    let pool = appv3_db::pool::create_pool(&appv3_core::settings().database_path).await?;
    manager::init(pool.clone(), appv3_agent::loader::default_provider_factory());

    let (workspace, session_id) = pick_session(&pool, args).await?;
    let Some(session) = manager::get_or_start_agent_session(&workspace, Some(&session_id)).await.map_err(|e| anyhow!("{e}"))? else {
        bail!("no agent is configured");
    };
    let dispatch =
        service::Dispatch { content: args.prompt.clone(), session_id: Some(session_id), workspace: Some(workspace), model, thinking_level: thinking, ..Default::default() };
    let (session_id, _, _) = service::dispatch_user_message(&session, dispatch).await.map_err(|e| anyhow!("{e}"))?;

    let mut out = std::io::stdout().lock();
    if args.json {
        let ev = events::session(&session_id).to_wire();
        writeln!(out, "{}", json_line(&ev.event, &ev.data))?;
        out.flush()?;
    }
    let mut wrote_text = false;
    let mut terminal_error: Option<String> = None;
    let lead_name = session.name();
    if let Some(mut sub) = stream_store::store().attach(&session_id) {
        while let Some(ev) = sub.next().await {
            if args.json {
                writeln!(out, "{}", json_line(&ev.event, &ev.data))?;
                out.flush()?;
            }
            let data: serde_json::Map<String, Value> = match serde_json::from_str::<Value>(&ev.data) {
                Ok(Value::Object(m)) => m,
                _ => Default::default(),
            };
            let s = |k: &str| data.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(String::from);
            match ev.event.as_str() {
                "message" if !args.json => {
                    let agent = data.get("agent").and_then(|v| v.as_str());
                    if agent.is_some_and(|a| a == lead_name || a == "openagentd" || a == "lead") {
                        if let Some(t) = s("text") {
                            write!(out, "{t}")?;
                            out.flush()?;
                            wrote_text = true;
                        }
                    }
                }
                "error" => terminal_error = Some(s("title").or_else(|| s("code")).unwrap_or_else(|| "the agent run failed".into())),
                "agent_not_configured" => terminal_error = Some(s("message").unwrap_or_else(|| "the agent is not configured".into())),
                "question_asked" => {
                    service::interrupt_agent(&session, Some(&session_id)).await;
                    terminal_error = Some("the agent asked a question, which a non-interactive run cannot answer".into());
                    break;
                }
                _ => {}
            }
        }
    }
    if wrote_text {
        writeln!(out)?;
    }
    drop(out);
    if !args.json && std::io::stderr().is_terminal() {
        eprintln!("session: {session_id}");
    }
    match terminal_error {
        Some(e) => Err(anyhow!(e)),
        None => Ok(()),
    }
}

pub fn run(args: &RunArgs) -> Result<()> {
    appv3_core::env::init_env();
    appv3_core::env::load_config_env(&appv3_core::settings().config_dir);
    crate::logging::setup("ERROR", "DEBUG", true);
    appv3_providers::credentials_migration::migrate_active();
    crate::dotenv::migrate();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let res = rt.block_on(run_turn(args));
    rt.shutdown_background();
    res
}

#[cfg(test)]
mod tests {
    use super::json_line;

    #[test]
    fn json_lines_put_the_event_first_and_embed_data() {
        assert_eq!(json_line("message", r#"{"type":"message","text":"hi"}"#), r#"{"event":"message","data":{"type":"message","text":"hi"}}"#);
        assert_eq!(json_line("x", "not json"), r#"{"event":"x","data":"not json"}"#);
    }
}
