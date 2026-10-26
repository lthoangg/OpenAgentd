//! `agentd` (v3): the Rust backend binary and its command-line interface.
//! `server serve` is the foreground server the desktop sidecar runs, and
//! `server start` runs it as a background daemon.

mod cli;
mod cmd;
mod logging;
mod net;
mod paths;
mod qr;
mod ui;

use clap::{CommandFactory, Parser};
use cli::{Cli, Command, ServerCmd, TransferCmd};
use std::process::ExitCode;

fn dispatch(command: Command) -> anyhow::Result<ExitCode> {
    let done = |r: anyhow::Result<()>| r.map(|()| ExitCode::SUCCESS);
    match command {
        Command::Server(s) => match s {
            ServerCmd::Start(a) => cmd::server::start(&a),
            ServerCmd::Stop => done(cmd::server::stop()),
            ServerCmd::Restart(a) => cmd::server::restart(&a),
            ServerCmd::Status(a) => cmd::server::status(&a),
            ServerCmd::Logs(a) => done(cmd::server::logs(&a)),
            ServerCmd::Serve(a) => done(cmd::serve::serve(&a)),
        },
        Command::Run(a) => done(cmd::run::run(&a)),
        Command::Auth(a) => cmd::auth::auth(&a),
        Command::Credentials(c) => cmd::auth::credentials(&c),
        Command::Doctor => cmd::doctor::doctor(),
        Command::Cleanup(a) => done(cmd::cleanup::cleanup(&a)),
        Command::Transfer(t) => done(match t {
            TransferCmd::Export(a) => cmd::transfer::export(&a),
            TransferCmd::Import(a) => cmd::transfer::import(&a),
        }),
        Command::Lsp(l) => done(cmd::lsp::lsp(&l)),
        Command::Upgrade => cmd::upgrade::upgrade(),
    }
}

fn main() -> ExitCode {
    logging::mark_start();
    // The build picks the mode (release: production); an OPENAGENTD_ENV
    // that names neither mode would otherwise fall back silently.
    if let Err(e) = appv3_core::settings::mode_from_env() {
        ui::print_error(&e);
        return ExitCode::FAILURE;
    }
    let result = match Cli::parse().command {
        // Bare `agentd` is reserved for a future TUI; print help for now.
        None => Cli::command().print_help().map(|()| ExitCode::SUCCESS).map_err(Into::into),
        Some(command) => dispatch(command),
    };
    use std::io::Write;
    let _ = std::io::stdout().flush();
    match result {
        Ok(code) => code,
        Err(e) => {
            ui::print_error(&format!("{e:#}"));
            ExitCode::FAILURE
        }
    }
}
