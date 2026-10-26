//! `agentd server serve`: the foreground server. The desktop sidecar,
//! `make run`, and the `server start` daemon all run this.

use crate::cli::ServeArgs;
use crate::cmd::server::DAEMON_ENV;
use appv3_api::{create_app, AppState, ConnInfo, NoDelayTcpListener, Policy};
use serde_json::json;
use std::io::Write;
use std::sync::OnceLock;
use tokio::sync::Notify;

/// stderr at `LOG_LEVEL`, `app.log` at `FILE_LOG_LEVEL`. The daemon's stderr
/// is appended to `app.log` too, so it keeps log records off stderr (the
/// file sink already has them) and only stray output such as a fatal
/// error lands there.
fn init_logging(daemon: bool) {
    let file_level = std::env::var("FILE_LOG_LEVEL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "DEBUG".into());
    let stderr_level = if daemon { "CRITICAL" } else { appv3_core::settings().log_level.as_str() };
    crate::logging::setup(stderr_level, &file_level, true);
    crate::logging::install_panic_hook();
}

/// Shutdown request from the parent-watch thread. A stored permit, so it
/// also works if the parent dies before the server awaits it.
fn parent_gone() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

/// Shut down gracefully when the parent dies, and exit hard if shutdown has
/// not finished within the grace period. Waits on the kernel's exit
/// notification; polls only where that isn't available.
fn start_parent_watch(parent: i32) {
    std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || {
            if crate::paths::wait_pid_exit(parent).is_none() {
                while crate::paths::pid_alive(parent) {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
            eprintln!("parent-watch: parent pid {parent} no longer alive; shutting down");
            parent_gone().notify_one();
            std::thread::sleep(std::time::Duration::from_secs(15));
            std::process::exit(1);
        })
        .expect("spawn parent watch");
}

fn emit_handshake(port: u16, token: Option<&str>, handshake_file: Option<&str>) {
    let mut payload = json!({"port": port, "pid": std::process::id(), "version": appv3_core::VERSION});
    if let Some(t) = token {
        payload["token"] = json!(t);
    }
    let line = appv3_core::pyjson::dumps(&payload);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "OPENAGENTD_HANDSHAKE {line}");
    let _ = out.flush();
    if let Some(path) = handshake_file {
        let tmp = format!("{path}.tmp");
        let res = std::fs::write(&tmp, &line).and_then(|_| std::fs::rename(&tmp, path));
        if let Err(e) = res {
            eprintln!("handshake file write failed path={path} error={e}");
        }
    }
}

async fn shutdown_signal() {
    let parent = parent_gone().notified();
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            _ = parent => {}
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = parent => {}
    }
}

pub fn serve(args: &ServeArgs) -> anyhow::Result<()> {
    // The desktop shell captures stderr into backend.log, and this line
    // marks the sidecar start there. The `server start` daemon skips it.
    let daemon = std::env::var_os(DAEMON_ENV).is_some();
    if !daemon {
        eprintln!("agentd: sidecar bootstrap");
    }
    std::env::remove_var(DAEMON_ENV);
    let host = args.host.clone();
    let port = args.port;
    // Token must be in env before the middleware policy is built.
    let token = if args.generate_token {
        let t = appv3_api::util::token_urlsafe();
        std::env::set_var("OPENAGENTD_DESKTOP_TOKEN", &t);
        Some(t)
    } else {
        std::env::var("OPENAGENTD_DESKTOP_TOKEN").ok().filter(|t| !t.is_empty())
    };
    appv3_core::env::init_env();
    let has_auth =
        token.is_some() || std::env::var("OPENAGENTD_ACCESS_KEY").is_ok_and(|v| !v.is_empty()) || crate::net::server_settings()?.access_key.is_some_and(|k| !k.is_empty());
    crate::net::require_loopback_or_auth(&host, has_auth)?;
    appv3_core::env::load_config_env(&appv3_core::settings().config_dir);
    init_logging(daemon);
    for n in appv3_core::env::env_notices() {
        tracing::warn!("env_file_skipped {n}");
    }
    appv3_providers::credentials_migration::migrate_active();
    if let Some(p) = args.parent_pid {
        start_parent_watch(p);
    }
    let handshake = args.handshake;
    // Read the token and handshake path, then drop them from the process
    // environment before any thread or child process can inherit them.
    let policy = Policy::from_env();
    let handshake_file = std::env::var(appv3_core::auth::HANDSHAKE_FILE_ENV).ok().filter(|p| !p.is_empty());
    appv3_core::auth::scrub_child_env_secrets();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async move {
        let s = appv3_core::settings();
        // Runs the migrations too.
        let pool = appv3_db::pool::create_pool(&s.database_path).await?;
        appv3_api::startup::startup(&pool).await?;

        let app = create_app(AppState { pool: pool.clone() }, policy.clone());
        let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
        let port = listener.local_addr()?.port();
        tracing::info!("server_listening host={} port={}", host, port);
        // A preview must never proxy back to this API from loopback.
        appv3_preview::block_port(port);
        // The desktop shell can open a LAN listener on demand ("Network access").
        if token.is_some() {
            appv3_api::network_access::install(app.clone(), policy, port);
        }
        if handshake {
            emit_handshake(port, token.as_deref(), handshake_file.as_deref());
        }
        // SSE streams never finish on their own, so end them as soon as the
        // signal arrives (sse-starlette does the same); the timeout only
        // bounds requests that are still running.
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let server = axum::serve(NoDelayTcpListener(listener), app.into_make_service_with_connect_info::<ConnInfo>()).with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("server_shutdown_requested");
            appv3_api::network_access::shutdown().await;
            appv3_api::startup::close_event_streams();
            let _ = tx.send(true);
        });
        tokio::select! {
            r = server => r?,
            _ = async {
                let _ = rx.wait_for(|v| *v).await;
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            } => tracing::info!("graceful_shutdown_timeout"),
        }
        appv3_api::startup::shutdown().await;
        appv3_db::close_pool(&pool).await;
        anyhow::Ok(())
    })
}
