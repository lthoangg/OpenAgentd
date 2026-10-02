//! `openagentd` (v3): the Rust backend binary and its command-line interface.
//! `server serve` is the foreground server the desktop sidecar runs, and
//! `server start` runs it as a background daemon.

mod cli;
mod cmd;
mod logging;
mod net;
mod paths;
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
        Command::Tui(a) => done(cmd::tui::tui(&a)),
        Command::Run(a) => done(cmd::run::run(&a)),
        Command::Auth(a) => cmd::auth::auth(&a),
        Command::Doctor => cmd::doctor::doctor(),
        Command::Cleanup(a) => done(cmd::cleanup::cleanup(&a)),
        Command::Transfer(t) => done(match t {
            TransferCmd::Migrate(a) => cmd::transfer::migrate(&a),
            TransferCmd::Export(a) => cmd::transfer::export(&a),
            TransferCmd::Import(a) => cmd::transfer::import(&a),
        }),
        Command::Lsp(l) => done(cmd::lsp::lsp(&l)),
        Command::Upgrade => cmd::upgrade::upgrade(),
    }
}

fn main() -> ExitCode {
    logging::mark_start();
    // The installed CLI is a production launcher; `server start` passes this
    // on to the daemon so both use the same state dir.
    if std::env::var_os("APP_ENV").is_none() {
        std::env::set_var("APP_ENV", "production");
    }
    let result = match Cli::parse().command {
        // Bare `openagentd` opens the TUI in a terminal; scripts get the help.
        None if std::io::IsTerminal::is_terminal(&std::io::stdin()) && std::io::IsTerminal::is_terminal(&std::io::stdout()) => {
            // Parse `tui` so its environment defaults apply.
            dispatch(Cli::parse_from(["openagentd", "tui"]).command.expect("tui parses"))
        }
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
