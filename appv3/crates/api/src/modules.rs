//! The server's built-in modules: the startup and shutdown steps the
//! server always had, each wrapped as it was.
//!
//! They are listed in start order. `deps` names only hard requirements
//! (restarting a module restarts what depends on it); the rest of the
//! order comes from this list. Stopping runs in reverse, which keeps the
//! shutdown order the server relies on: restart resume marks first, the
//! scheduler stops before the session manager, and member agents finish
//! their last saves before MCP, LSP and the database go away.

use appv3_agent::{loader, manager, scheduler};
use appv3_core::settings;
use appv3_db::DbPool;
use appv3_kernel::FnModule;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

type StartFut = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;
type StopFut = Pin<Box<dyn Future<Output = ()> + Send>>;

struct Spec {
    id: &'static str,
    deps: &'static [&'static str],
    critical: bool,
    start: Option<fn(DbPool) -> StartFut>,
    stop: Option<fn() -> StopFut>,
}

const BUILTIN: &[Spec] = &[
    Spec { id: "workspace", deps: &[], critical: true, start: Some(|_| Box::pin(async { crate::startup::ensure_workspace_initialized() })), stop: None },
    Spec {
        id: "otel",
        deps: &[],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                appv3_core::otel::setup("openagentd", None);
                appv3_core::otel::start_retention();
                Ok(())
            })
        }),
        stop: Some(|| {
            Box::pin(async {
                appv3_core::otel::stop_retention();
                appv3_core::otel::shutdown();
            })
        }),
    },
    Spec {
        id: "lsp",
        deps: &["workspace"],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                appv3_tools::lsp::set_event_publisher(appv3_agent::broadcaster::publish);
                appv3_tools::lsp::lsp_manager().start();
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(appv3_tools::lsp::lsp_manager().stop())),
    },
    Spec {
        id: "mcp",
        deps: &["workspace"],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                appv3_mcp::set_event_publisher(appv3_agent::broadcaster::publish);
                match appv3_mcp::config::load_config() {
                    Err(e) => tracing::error!("mcp_config_invalid err={}", e),
                    Ok(c) if c.servers.is_empty() => tracing::info!("mcp_no_servers_configured"),
                    Ok(_) => appv3_mcp::mcp_manager().start().await,
                }
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(async { appv3_mcp::mcp_manager().stop().await })),
    },
    // A lead's Stop only signals its members; their last saves must land
    // before the database closes.
    Spec { id: "subagents", deps: &[], critical: false, start: None, stop: Some(|| Box::pin(appv3_agent::subagents::stop_all_members(Duration::from_secs(5)))) },
    Spec {
        id: "sessions",
        deps: &["workspace", "subagents"],
        critical: true,
        start: Some(|pool| {
            Box::pin(async move {
                manager::init(pool, loader::default_provider_factory());
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(manager::stop())),
    },
    Spec {
        id: "stream_store",
        deps: &[],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                appv3_agent::stream_store::store().spawn_sweeper();
                Ok(())
            })
        }),
        stop: None,
    },
    Spec {
        id: "snapshots",
        deps: &[],
        critical: false,
        start: Some(|pool| {
            Box::pin(async move {
                appv3_agent::snapshot::start_maintenance(pool);
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(async { appv3_agent::snapshot::stop_maintenance() })),
    },
    // v2 re-raises an invalid agents dir and the server never starts.
    Spec {
        id: "agents",
        deps: &["workspace"],
        critical: true,
        start: Some(|_| {
            Box::pin(async {
                match manager::validate_agents_dir(None) {
                    Ok(false) => tracing::warn!("agents_dir_empty_or_missing path={}", settings().agents_dir.display()),
                    Ok(true) => {}
                    Err(e) => {
                        tracing::error!("agents_dir_invalid path={} error={}", settings().agents_dir.display(), e);
                        anyhow::bail!(e);
                    }
                }
                Ok(())
            })
        }),
        stop: None,
    },
    Spec {
        id: "scheduler",
        deps: &["sessions", "agents"],
        critical: true,
        start: Some(|pool| {
            Box::pin(async move {
                let sched = scheduler::init(pool);
                if sched.has_enabled_tasks().await {
                    sched.start().await?;
                } else {
                    tracing::info!("scheduler_no_enabled_tasks");
                }
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(async { scheduler::scheduler().stop() })),
    },
    Spec { id: "preview", deps: &[], critical: false, start: None, stop: Some(|| Box::pin(async { appv3_preview::shutdown() })) },
    Spec { id: "terminal", deps: &[], critical: false, start: None, stop: Some(|| Box::pin(appv3_terminal::close_all())) },
    // v2: refresh_model_registry(force=True) in the background; the
    // registry route awaits it. On shutdown, a refresh still on the network
    // must not outlast the desktop's shutdown grace period.
    Spec {
        id: "model_registry",
        deps: &[],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                if let Ok(guard) = crate::registry_refresh_gate().try_write_owned() {
                    tokio::spawn(async move {
                        appv3_providers::registry::refresh_model_registry(true).await;
                        drop(guard);
                    });
                }
                Ok(())
            })
        }),
        stop: Some(|| {
            Box::pin(async {
                let _ = tokio::time::timeout(Duration::from_secs(1), crate::registry_refresh_gate().read()).await;
            })
        }),
    },
    Spec {
        id: "shell_snapshot",
        deps: &[],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                appv3_tools::shell::prewarm_snapshot();
                Ok(())
            })
        }),
        stop: None,
    },
    Spec {
        id: "config_watch",
        deps: &["workspace"],
        critical: false,
        start: Some(|_| {
            Box::pin(async {
                crate::config_watch::start();
                Ok(())
            })
        }),
        stop: None,
    },
    // Turns stopped from shutdown on are continued by the next start.
    Spec {
        id: "restart_resume",
        deps: &["sessions"],
        critical: false,
        start: Some(|pool| {
            Box::pin(async move {
                // Idle-compaction countdowns live in memory; resume the ones
                // the restart dropped while the provider's prompt cache is
                // still warm.
                let p = pool.clone();
                tokio::spawn(async move { appv3_agent::idle_compaction::resume_after_restart(&p).await });
                // File worktrees and subfolders registered as repositories
                // before git's own link decided where a folder belongs.
                let p = pool.clone();
                tokio::spawn(async move { appv3_agent::worktrees::reclassify_workspaces(&p).await });
                // Continue the turns the last server process left running,
                // with their goals; a member it cut off reports that to its
                // lead.
                tokio::spawn(async move { appv3_agent::restart_resume::resume_after_restart(&pool).await });
                Ok(())
            })
        }),
        stop: Some(|| Box::pin(async { appv3_agent::restart_resume::begin_shutdown() })),
    },
];

/// The built-in modules, in start order.
pub fn builtin(pool: &DbPool) -> Vec<FnModule> {
    BUILTIN
        .iter()
        .map(|s| {
            let mut m = FnModule::new(s.id).depends_on(s.deps).critical(s.critical);
            if let Some(start) = s.start {
                let pool = pool.clone();
                m = m.on_start(move || start(pool.clone()));
            }
            if let Some(stop) = s.stop {
                m = m.on_stop(stop);
            }
            m
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_kernel::Kernel;
    use std::sync::{Arc, Mutex};

    /// The built-in specs with their hooks replaced by recorders.
    async fn run_recorded() -> (Vec<String>, Vec<String>) {
        let (starts, stops) = (Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])));
        let k = Kernel::new();
        for s in BUILTIN {
            let (a, b) = (starts.clone(), stops.clone());
            let mut m = FnModule::new(s.id).depends_on(s.deps).critical(s.critical).on_start(move || {
                a.lock().unwrap().push(s.id.to_string());
                async { Ok(()) }
            });
            if s.stop.is_some() {
                m = m.on_stop(move || {
                    b.lock().unwrap().push(s.id.to_string());
                    async {}
                });
            }
            k.add(m).unwrap();
        }
        k.start_all().await.unwrap();
        k.stop_all().await;
        let out = (starts.lock().unwrap().clone(), stops.lock().unwrap().clone());
        out
    }

    #[tokio::test]
    async fn builtin_modules_stop_in_the_servers_shutdown_order() {
        let (_, stops) = run_recorded().await;
        assert_eq!(stops, ["restart_resume", "model_registry", "terminal", "preview", "scheduler", "snapshots", "sessions", "subagents", "mcp", "lsp", "otel"]);
    }

    #[tokio::test]
    async fn builtin_modules_start_in_the_order_listed() {
        let (starts, _) = run_recorded().await;
        assert_eq!(starts, BUILTIN.iter().map(|s| s.id).collect::<Vec<_>>());
        assert_eq!(starts[0], "workspace", "the workspace exists before anything reads it");
    }

    #[test]
    fn only_steps_that_stopped_the_server_before_are_critical() {
        let critical: Vec<&str> = BUILTIN.iter().filter(|s| s.critical).map(|s| s.id).collect();
        assert_eq!(critical, ["workspace", "sessions", "agents", "scheduler"]);
    }
}
