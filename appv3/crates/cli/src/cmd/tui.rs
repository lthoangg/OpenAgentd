//! `openagentd tui` (and bare `openagentd` in a terminal): the terminal UI.
//! It is a client of the background server, which it starts when needed.

use crate::cli::{AddrArgs, StartArgs, TuiArgs};
use crate::net::{display_host, http_get, resolve_addr, server_settings};
use anyhow::{bail, Context, Result};
use std::io::IsTerminal;
use std::time::{Duration, Instant};

fn ready(host: &str, port: u16) -> bool {
    matches!(http_get(host, port, "/api/health/ready", Duration::from_secs(2)), Some((200, _)))
}

/// The local server's URL, starting the background server if it is down.
fn local_server() -> Result<String> {
    let cfg = server_settings()?;
    let (bind, port) = resolve_addr(None, None, &cfg);
    let host = display_host(&bind);
    if !ready(&host, port) {
        if crate::paths::find_pids().is_empty() {
            let started = crate::cmd::server::start(&StartArgs { addr: AddrArgs::default(), key: false, wait: true })?;
            if started != std::process::ExitCode::SUCCESS {
                bail!("the background server did not start; see `openagentd server logs`");
            }
        }
        // A server that is already starting needs a moment more.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready(&host, port) {
            if Instant::now() > deadline {
                bail!("the server at {host}:{port} is not ready; check `openagentd server status`");
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    let host = if host.contains(':') { format!("[{host}]") } else { host };
    Ok(format!("http://{host}:{port}"))
}

pub fn tui(args: &TuiArgs) -> Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!("the TUI needs an interactive terminal; use `openagentd run` for scripts");
    }
    let theme: appv3_tui::ThemeChoice = args.theme.parse().map_err(anyhow::Error::msg)?;
    let base_url = match &args.url {
        Some(u) => u.clone(),
        None => local_server()?,
    };
    // An explicit key wins; otherwise the local server's own access key.
    let token = std::env::var("OPENAGENTD_ACCESS_KEY").ok().filter(|k| !k.is_empty()).or_else(|| if args.url.is_none() { server_settings().ok()?.access_key } else { None });
    let cwd = std::env::current_dir().context("read the current directory")?;
    let dir = match &args.cd {
        Some(d) => cwd.join(d),
        None => cwd,
    };
    let workspace = dunce::canonicalize(&dir).with_context(|| format!("open {}", dir.display()))?.display().to_string();
    let session = match (&args.session, args.continue_session) {
        (Some(id), _) => appv3_tui::SessionPick::Id(id.clone()),
        (None, true) => appv3_tui::SessionPick::Continue,
        (None, false) => appv3_tui::SessionPick::New,
    };
    let opts = appv3_tui::Options { base_url, token, workspace, session, theme, history_file: Some(appv3_core::settings().state_dir.join("tui_history.jsonl")) };
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let res = rt.block_on(appv3_tui::run(opts));
    // The input reader and stream tasks never finish on their own.
    rt.shutdown_background();
    res
}
