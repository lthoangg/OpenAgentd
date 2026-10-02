//! The `openagentd` command tree.
//!
//! Bare `openagentd` opens the TUI in a terminal and prints help otherwise.

use clap::builder::PossibleValuesParser;
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

const EXAMPLES: &str = "\
Examples:
  openagentd                                     Chat with the agent in this folder (same as `tui`)
  openagentd tui --continue                      Continue this folder's latest session
  openagentd server start                        Start the background server
  openagentd server start --host 0.0.0.0 --key   Serve phones and other computers on the LAN
  openagentd server status                       Check the background server
  openagentd run --prompt 'Summarize this repo'  Run one agent turn in this folder
  openagentd auth copilot                        Log in to an OAuth provider";

#[derive(Debug, Parser)]
#[command(name = "openagentd", version = concat!("v", env!("CARGO_PKG_VERSION")), about = "OpenAgentd — local-first coding agent", after_help = EXAMPLES)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start, stop, and inspect the API server
    #[command(subcommand)]
    Server(ServerCmd),
    /// Chat with the agent in the terminal (bare `openagentd` does the same)
    Tui(TuiArgs),
    /// Run one agent turn in a workspace and print the reply
    Run(RunArgs),
    /// Log in to or out of OAuth model providers
    Auth(AuthArgs),
    /// Check the configuration and report problems
    Doctor,
    /// Remove old sessions and generated files (dry run by default)
    Cleanup(CleanupArgs),
    /// Import, export, or migrate agent configuration
    #[command(subcommand)]
    Transfer(TransferCmd),
    /// Inspect or install managed language servers
    #[command(subcommand)]
    Lsp(LspCmd),
    /// Update openagentd to the latest release
    #[command(visible_alias = "update")]
    Upgrade,
}

#[derive(Debug, Subcommand)]
pub enum ServerCmd {
    /// Start the background server
    Start(StartArgs),
    /// Stop the background server
    Stop,
    /// Restart the background server
    Restart(StartArgs),
    /// Show whether the server is running and healthy
    #[command(alias = "health")]
    Status(AddrArgs),
    /// Follow the server log
    Logs(LogsArgs),
    /// Run the server in the foreground (desktop sidecar, `make run`)
    Serve(ServeArgs),
}

#[derive(Debug, Args, Default)]
pub struct AddrArgs {
    /// Server host (default: server.yaml, then 127.0.0.1)
    #[arg(long)]
    pub host: Option<String>,
    /// Server port (default: server.yaml, then 4082)
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    pub port: Option<u16>,
}

#[derive(Debug, Args)]
pub struct StartArgs {
    #[command(flatten)]
    pub addr: AddrArgs,
    /// Prompt for the access key clients must send (required beyond loopback)
    #[arg(long)]
    pub key: bool,
    /// Wait until the server is ready (up to 30 s); exit 1 if it is not
    #[arg(long)]
    pub wait: bool,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    /// Lines to show before following
    #[arg(short = 'n', long, default_value_t = 50)]
    pub lines: usize,
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Bind host
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    /// Bind port (0 picks a free port)
    #[arg(long, default_value_t = 0)]
    pub port: u16,
    /// Print one `OPENAGENTD_HANDSHAKE {json}` line on stdout once listening
    #[arg(long)]
    pub handshake: bool,
    /// Require a random session token and include it in the handshake
    #[arg(long)]
    pub generate_token: bool,
    /// Exit when this process is gone
    #[arg(long, value_name = "PID")]
    pub parent_pid: Option<i32>,
}

#[derive(Debug, Args)]
pub struct RunArgs {
    /// Prompt to send to the agent
    #[arg(long)]
    pub prompt: String,
    /// Model override, e.g. openai:gpt-5.5
    #[arg(long)]
    pub model: Option<String>,
    /// Thinking level override
    #[arg(long)]
    pub thinking: Option<String>,
    /// Workspace directory (default: the current directory)
    #[arg(short = 'C', long = "cd", value_name = "DIR", conflicts_with = "session")]
    pub cd: Option<PathBuf>,
    /// Continue the workspace's latest session
    #[arg(short = 'c', long = "continue", conflicts_with = "session")]
    pub continue_session: bool,
    /// Continue the session with this ID, in its own workspace
    #[arg(long, value_name = "ID")]
    pub session: Option<String>,
    /// Print every stream event as one JSON line instead of the reply text
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct TuiArgs {
    /// Workspace directory (default: the current directory)
    #[arg(short = 'C', long = "cd", value_name = "DIR")]
    pub cd: Option<PathBuf>,
    /// Continue the workspace's latest session
    #[arg(short = 'c', long = "continue", conflicts_with = "session")]
    pub continue_session: bool,
    /// Open the session with this ID
    #[arg(long, value_name = "ID")]
    pub session: Option<String>,
    /// Model for new messages, e.g. openai:gpt-5.5 (default: the session's
    /// model, else the newest one used in this folder, else anywhere)
    #[arg(long)]
    pub model: Option<String>,
    /// Color theme
    #[arg(long, env = "OPENAGENTD_TUI_THEME", default_value = "auto", value_parser = ["auto", "dark", "light"])]
    pub theme: String,
    /// Connect to this server instead of the local background server
    /// (send its access key in OPENAGENTD_ACCESS_KEY)
    #[arg(long, env = "OPENAGENTD_URL", value_name = "URL")]
    pub url: Option<String>,
}

fn oauth_providers() -> PossibleValuesParser {
    PossibleValuesParser::new(appv3_providers::oauth::PROVIDERS.map(|(id, _)| id))
}

/// `auth <provider>` logs in; `auth list` / `auth logout <provider>`.
#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub action: Option<AuthCmd>,
    /// Provider to log in to
    #[arg(value_parser = oauth_providers())]
    pub provider: Option<String>,
    /// Use the headless device-code flow (codex)
    #[arg(long)]
    pub device: bool,
    /// Same as `auth list`
    #[arg(long, hide = true)]
    pub list: bool,
}

#[derive(Debug, Subcommand)]
pub enum AuthCmd {
    /// Show which providers are logged in
    List,
    /// Remove a provider's saved login
    Logout {
        #[arg(value_parser = oauth_providers())]
        provider: String,
    },
}

#[derive(Debug, Args)]
pub struct CleanupArgs {
    /// Only remove sessions and files older than this many days
    #[arg(long, value_name = "DAYS", default_value_t = 14)]
    pub older_than_days: u32,
    /// Delete the listed items (default: dry run)
    #[arg(long)]
    pub apply: bool,
    /// Compact the SQLite database afterwards
    #[arg(long, requires = "apply")]
    pub vacuum: bool,
    /// Items to list (0 lists all)
    #[arg(long, value_name = "N", default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Subcommand)]
pub enum TransferCmd {
    /// Import agent instructions from OpenClaw or Hermes
    Migrate(MigrateArgs),
    /// Pack agents, skills, commands, plugins, and config into a .tar.gz
    ///
    /// API keys in .env and the server access key are redacted unless
    /// --include-secrets is given.
    Export(ExportArgs),
    /// Unpack an export archive into the config directory
    ///
    /// Existing files are kept unless --force is given.
    Import(ImportArgs),
}

#[derive(Debug, Clone, Copy, PartialEq, ValueEnum)]
pub enum MigrateSource {
    Openclaw,
    Hermes,
}

#[derive(Debug, Args)]
pub struct MigrateArgs {
    /// Tool to import from
    pub source: MigrateSource,
    /// Source directory (default: ~/.openclaw/workspace or ~/.hermes)
    #[arg(long, value_name = "DIR")]
    pub from: Option<PathBuf>,
    /// Model for the imported agent, e.g. openai:gpt-5.5
    #[arg(long)]
    pub model: String,
    /// Config directory to write to (default: the active one)
    #[arg(long, value_name = "DIR")]
    pub config_dir: Option<PathBuf>,
    /// Replace an existing agents/code.md
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct ExportArgs {
    /// Archive path (default: ./openagentd-export-<timestamp>.tar.gz)
    #[arg(short, long, value_name = "PATH")]
    pub output: Option<PathBuf>,
    /// Keep API keys and the access key (trusted channels only)
    #[arg(long)]
    pub include_secrets: bool,
    /// Config directory to export (default: the active one)
    #[arg(long, value_name = "DIR")]
    pub config_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ImportArgs {
    /// Archive made by `openagentd transfer export`
    pub archive: PathBuf,
    /// Overwrite files that already exist
    #[arg(long)]
    pub force: bool,
    /// Config directory to import into (default: the active one)
    #[arg(long, value_name = "DIR")]
    pub config_dir: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum LspCmd {
    /// Show managed language server status
    Status,
    /// Install a managed language server
    Install(LspInstallArgs),
}

#[derive(Debug, Clone, Copy, PartialEq, ValueEnum)]
pub enum LspComponent {
    Typescript,
    Python,
}

#[derive(Debug, Clone, Copy, PartialEq, ValueEnum)]
pub enum PythonTool {
    Ruff,
    Ty,
}

impl PythonTool {
    pub fn name(self) -> &'static str {
        match self {
            PythonTool::Ruff => "ruff",
            PythonTool::Ty => "ty",
        }
    }
}

#[derive(Debug, Args)]
pub struct LspInstallArgs {
    pub component: LspComponent,
    /// Python tool to install (required for python)
    #[arg(required_if_eq("component", "python"))]
    pub tool: Option<PythonTool>,
    /// Exact PyPI version (default: latest)
    #[arg(long)]
    pub version: Option<String>,
    /// Download again even if already installed
    #[arg(long)]
    pub force: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Result<Option<Command>, clap::Error> {
        Cli::try_parse_from(std::iter::once("openagentd").chain(args.iter().copied())).map(|c| c.command)
    }

    fn kind(args: &[&str]) -> ErrorKind {
        parse(args).expect_err("must not parse").kind()
    }

    #[test]
    fn the_tree_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn version_matches_the_release_contract() {
        assert_eq!(Cli::command().render_version(), format!("openagentd v{}\n", appv3_core::VERSION));
    }

    #[test]
    fn bare_openagentd_has_no_command() {
        assert!(parse(&[]).unwrap().is_none());
    }

    #[test]
    fn desktop_sidecar_invocation_parses() {
        let args = ["server", "serve", "--host", "127.0.0.1", "--port", "0", "--handshake", "--generate-token", "--parent-pid", "42"];
        let Some(Command::Server(ServerCmd::Serve(a))) = parse(&args).unwrap() else { panic!("not serve") };
        assert_eq!((a.host.as_str(), a.port, a.handshake, a.generate_token, a.parent_pid), ("127.0.0.1", 0, true, true, Some(42)));
        let Some(Command::Server(ServerCmd::Serve(d))) = parse(&["server", "serve"]).unwrap() else { panic!("not serve") };
        assert_eq!((d.host.as_str(), d.port, d.handshake, d.parent_pid), ("127.0.0.1", 0, false, None));
    }

    #[test]
    fn start_flags_parse_and_port_zero_is_refused() {
        let Some(Command::Server(ServerCmd::Start(a))) = parse(&["server", "start", "--host", "0.0.0.0", "--port", "9000", "--key", "--wait"]).unwrap() else {
            panic!("not start")
        };
        assert_eq!((a.addr.host.as_deref(), a.addr.port, a.key, a.wait), (Some("0.0.0.0"), Some(9000), true, true));
        assert_eq!(kind(&["server", "start", "--port", "0"]), ErrorKind::ValueValidation);
    }

    #[test]
    fn health_is_a_hidden_alias_of_status() {
        assert!(matches!(parse(&["server", "health", "--port", "5000"]).unwrap(), Some(Command::Server(ServerCmd::Status(AddrArgs { port: Some(5000), .. })))));
        let mut server = Cli::command().find_subcommand("server").unwrap().clone();
        assert!(!server.render_help().to_string().lines().any(|l| l.trim_start().starts_with("health")));
    }

    #[test]
    fn run_flags_and_conflicts() {
        let Some(Command::Run(a)) = parse(&["run", "--prompt", "hi", "-C", "/tmp", "-c", "--json", "--model", "openai:gpt-5.5", "--thinking", "high"]).unwrap() else {
            panic!("not run")
        };
        assert_eq!(a.prompt, "hi");
        assert_eq!(a.cd.as_deref(), Some(std::path::Path::new("/tmp")));
        assert!(a.continue_session && a.json && a.session.is_none());
        assert_eq!((a.model.as_deref(), a.thinking.as_deref()), (Some("openai:gpt-5.5"), Some("high")));
        let Some(Command::Run(s)) = parse(&["run", "--prompt", "hi", "--session", "abc"]).unwrap() else { panic!("not run") };
        assert_eq!(s.session.as_deref(), Some("abc"));
        assert_eq!(kind(&["run"]), ErrorKind::MissingRequiredArgument);
        assert_eq!(kind(&["run", "--prompt", "hi", "--continue", "--session", "abc"]), ErrorKind::ArgumentConflict);
        assert_eq!(kind(&["run", "--prompt", "hi", "--cd", "/tmp", "--session", "abc"]), ErrorKind::ArgumentConflict);
    }

    #[test]
    fn auth_shapes() {
        let auth = |args: &[&str]| match parse(args).unwrap() {
            Some(Command::Auth(a)) => a,
            other => panic!("not auth: {other:?}"),
        };
        let a = auth(&["auth", "copilot", "--device"]);
        assert_eq!((a.provider.as_deref(), a.device, a.action.is_none()), (Some("copilot"), true, true));
        assert!(matches!(auth(&["auth", "list"]).action, Some(AuthCmd::List)));
        assert!(matches!(auth(&["auth", "logout", "codex"]).action, Some(AuthCmd::Logout { ref provider }) if provider == "codex"));
        assert!(auth(&["auth", "--list"]).list);
        let bare = auth(&["auth"]);
        assert!(bare.action.is_none() && bare.provider.is_none());
        assert_eq!(kind(&["auth", "nope"]), ErrorKind::InvalidValue);
        assert_eq!(kind(&["auth", "logout", "nope"]), ErrorKind::InvalidValue);
    }

    #[test]
    fn tui_flags_and_conflicts() {
        let Some(Command::Tui(a)) = parse(&["tui", "-c", "--theme", "light", "-C", "/tmp"]).unwrap() else { panic!("not tui") };
        assert!(a.continue_session && a.session.is_none());
        assert_eq!((a.theme.as_str(), a.cd.as_deref()), ("light", Some(std::path::Path::new("/tmp"))));
        assert_eq!(kind(&["tui", "--continue", "--session", "abc"]), ErrorKind::ArgumentConflict);
        assert_eq!(kind(&["tui", "--theme", "blue"]), ErrorKind::InvalidValue);
    }

    #[test]
    fn update_is_an_alias_of_upgrade() {
        assert!(matches!(parse(&["update"]).unwrap(), Some(Command::Upgrade)));
        assert!(matches!(parse(&["upgrade"]).unwrap(), Some(Command::Upgrade)));
    }

    #[test]
    fn lsp_python_needs_a_tool() {
        assert_eq!(kind(&["lsp", "install", "python"]), ErrorKind::MissingRequiredArgument);
        let Some(Command::Lsp(LspCmd::Install(a))) = parse(&["lsp", "install", "python", "ruff", "--version", "0.6.0", "--force"]).unwrap() else { panic!("not lsp install") };
        assert_eq!((a.component, a.tool, a.version.as_deref(), a.force), (LspComponent::Python, Some(PythonTool::Ruff), Some("0.6.0"), true));
        assert!(matches!(parse(&["lsp", "install", "typescript"]).unwrap(), Some(Command::Lsp(LspCmd::Install(LspInstallArgs { tool: None, .. })))));
    }

    #[test]
    fn cleanup_defaults_and_vacuum_needs_apply() {
        let Some(Command::Cleanup(a)) = parse(&["cleanup"]).unwrap() else { panic!("not cleanup") };
        assert_eq!((a.older_than_days, a.apply, a.vacuum, a.limit), (14, false, false, 20));
        assert_eq!(kind(&["cleanup", "--vacuum"]), ErrorKind::MissingRequiredArgument);
        assert!(matches!(parse(&["cleanup", "--apply", "--vacuum", "--limit", "0"]).unwrap(), Some(Command::Cleanup(CleanupArgs { vacuum: true, limit: 0, .. }))));
    }

    #[test]
    fn transfer_parses() {
        let Some(Command::Transfer(TransferCmd::Export(e))) = parse(&["transfer", "export", "-o", "x.tar.gz", "--include-secrets"]).unwrap() else { panic!("not export") };
        assert_eq!((e.output.as_deref(), e.include_secrets), (Some(std::path::Path::new("x.tar.gz")), true));
        let Some(Command::Transfer(TransferCmd::Migrate(m))) = parse(&["transfer", "migrate", "hermes", "--model", "openai:gpt-5.5"]).unwrap() else { panic!("not migrate") };
        assert_eq!((m.source, m.model.as_str(), m.from.is_none()), (MigrateSource::Hermes, "openai:gpt-5.5", true));
        assert_eq!(kind(&["transfer", "migrate", "openclaw"]), ErrorKind::MissingRequiredArgument);
        assert_eq!(kind(&["transfer", "import"]), ErrorKind::MissingRequiredArgument);
    }

    #[test]
    fn unknown_commands_are_usage_errors() {
        assert_eq!(kind(&["bogus"]), ErrorKind::InvalidSubcommand);
        assert_eq!(kind(&["serve"]), ErrorKind::InvalidSubcommand);
    }
}
