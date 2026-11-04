//! `agentd plugin add`: install a plugin from a folder or a git URL.

use super::prompt::{ask, Consent};
use super::reload::reload_server;
use super::render::{emit, exact, ind, inline, sp, verdict, Tone};
use super::source::{check_links, parse_source, pth, stage_source};
use super::summary::{code_lines, load_code, summary};
use super::{installed, Ctx};
use crate::cli::PluginAddArgs;
use crate::ui::tilde;
use anyhow::{anyhow, bail, Context, Result};
use appv3_plugins::{data_dir_name, disabled, load, set_enabled};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// Staging folders live in the plugins folder under this prefix; discovery
/// skips names that start with `.`, and the final move is a rename on one
/// file system.
const STAGING_PREFIX: &str = ".agentd-add-";

impl Ctx {
    fn install_dir(&self) -> Result<&Path> {
        self.dirs.first().map(PathBuf::as_path).context("no plugin folder is configured (OPENAGENTD_PLUGINS_DIRS is empty)")
    }
}

pub(super) fn add(args: &PluginAddArgs) -> Result<ExitCode> {
    let source = parse_source(&args.source).map_err(|why| anyhow!("{why}"))?;
    let ctx = Ctx::new();
    let install_dir = ctx.install_dir()?;
    std::fs::create_dir_all(install_dir).with_context(|| format!("create {}", pth(install_dir)))?;
    // Dropped on every way out of this function: whatever it holds is removed.
    let staging = tempfile::Builder::new().prefix(STAGING_PREFIX).tempdir_in(install_dir).context("create a staging folder")?;
    let stage = dunce::canonicalize(staging.path()).context("open the staging folder")?;

    let root = stage_source(&source, args.path.as_deref(), &stage)?;
    check_links(&root)?;
    let bundle = load(&root, &ctx.data_root).map_err(|why| anyhow!("the plugin was rejected: {}", inline(&why, 500)))?;

    let dest = install_dir.join(data_dir_name(&bundle.name));
    let name = exact(&bundle.name);
    if std::fs::symlink_metadata(&dest).is_ok() {
        bail!("{name} is already installed at {}; remove it first (agentd plugin remove {name})", pth(&dest));
    }
    let wanted = data_dir_name(&bundle.name);
    if let Some(other) = installed(&ctx.dirs, &ctx.data_root).iter().find(|i| i.bundle.as_ref().is_ok_and(|b| data_dir_name(&b.name) == wanted)) {
        bail!("{name} is already installed at {}; remove it first (agentd plugin remove {name})", pth(&other.folder));
    }

    let mut out = summary(&bundle, Some(&dest));
    let scratch = tempfile::tempdir().context("create a scratch folder")?;
    if let Some(code) = load_code(&bundle, scratch.path()) {
        out.extend(code_lines(&code));
    }
    emit(&out);

    match ask(args.yes, &format!("Install {name}?"))? {
        Consent::Yes => {}
        Consent::No => {
            println!("\n  Cancelled; nothing was installed.\n");
            return Ok(ExitCode::FAILURE);
        }
        Consent::NeedsFlag => {
            println!("\n  Re-run with --yes to install.\n");
            return Ok(ExitCode::from(2));
        }
    }

    std::fs::rename(&root, &dest).with_context(|| format!("move the plugin into {}", pth(&dest)))?;
    let staging_path = staging.path().to_path_buf();
    if let Err(e) = staging.close() {
        emit(&[verdict(Tone::Warn, "⚠", &format!("Could not remove the staging folder {}: {e}", pth(&staging_path)))]);
    }
    println!();
    emit(&[verdict(Tone::Good, "✓", &format!("Installed {name} in {}", tilde(&dest)))]);

    // A name left in the disabled list by an earlier install would keep the plugin off.
    if disabled(&ctx.config_dir).contains(&bundle.name) {
        set_enabled(&ctx.config_dir, &bundle.name, true).context("turn the plugin on")?;
        emit(&[vec![ind(2), sp(Tone::Dim, "It was listed as disabled in plugins.json from an earlier install; it is enabled now.")]]);
    }

    let (lines, loads) = reload_server(&bundle.name, false);
    emit(&lines);
    if loads {
        emit(&[vec![ind(2), sp(Tone::Dim, "New sessions get its skills, MCP servers and tools.")]]);
    }
    println!();
    Ok(ExitCode::SUCCESS)
}
