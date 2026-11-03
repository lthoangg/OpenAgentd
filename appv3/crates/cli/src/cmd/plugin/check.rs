//! `agentd plugin check`: validate a plugin folder without installing it.

use super::render::{blank, emit, inline, plural, verdict, Tone};
use super::summary::{code_lines, load_code, summary};
use super::Ctx;
use crate::cli::PluginCheckArgs;
use anyhow::{Context, Result};
use appv3_plugins::load;
use std::process::ExitCode;

pub(super) fn check(args: &PluginCheckArgs) -> Result<ExitCode> {
    let ctx = Ctx::new();
    let bundle = match load(&args.folder, &ctx.data_root) {
        Ok(b) => b,
        Err(why) => {
            emit(&[blank(), verdict(Tone::Bad, "✗", &format!("Rejected: {}", inline(&why, 500))), blank()]);
            return Ok(ExitCode::FAILURE);
        }
    };
    let mut out = summary(&bundle, None);
    let scratch = tempfile::tempdir().context("create a scratch folder")?;
    let mut warnings = bundle.warnings.len();
    let mut failed = false;
    if let Some(code) = load_code(&bundle, scratch.path()) {
        out.extend(code_lines(&code));
        match &code {
            Ok(report) => warnings += report.warnings.len(),
            Err(_) => failed = true,
        }
    }
    out.push(blank());
    out.push(match (failed, warnings) {
        (true, _) => verdict(Tone::Bad, "✗", "The plugin's code failed to load"),
        (false, 0) => verdict(Tone::Good, "✓", "Valid"),
        (false, n) => verdict(Tone::Warn, "⚠", &format!("Valid, with {}", plural(n, "warning", "warnings"))),
    });
    out.push(blank());
    emit(&out);
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}
