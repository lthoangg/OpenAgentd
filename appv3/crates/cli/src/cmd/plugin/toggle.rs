//! `agentd plugin enable` and `agentd plugin disable`: turn an installed
//! plugin on or off in `plugins.json`, which the server reads. The plugin
//! stays installed.

use super::reload::{reload_server, Change};
use super::render::{emit, exact, verdict, Tone};
use super::source::pth;
use super::{installed, Ctx, Installed};
use crate::cli::PluginToggleArgs;
use anyhow::{bail, Context, Result};
use appv3_plugins::{disabled, set_enabled};
use std::process::ExitCode;

pub(super) fn toggle(args: &PluginToggleArgs, enable: bool) -> Result<ExitCode> {
    let ctx = Ctx::new();
    let items = installed(&ctx.dirs, &ctx.data_root);
    let wanted = exact(&args.name);
    let found: Vec<&Installed> = items.iter().filter(|i| i.matches(&args.name)).collect();
    let target = match found.as_slice() {
        [one] => *one,
        [] => {
            let single_file = appv3_jsplugin::plugin_files(&ctx.dirs)
                .into_iter()
                .find(|f| f.file_stem().is_some_and(|s| s.to_string_lossy() == args.name) || f.file_name().is_some_and(|n| n.to_string_lossy() == args.name));
            if let Some(file) = single_file {
                if enable {
                    bail!("{wanted} is a single-file plugin ({}); it is on whenever the server runs, unless its file name starts with `_`", pth(&file));
                }
                bail!("{wanted} is a single-file plugin ({}); rename it to start with `_` and restart the server to turn it off", pth(&file));
            }
            let names: Vec<String> = items.iter().map(|i| exact(&i.name())).collect();
            bail!("no plugin named {wanted}; {}", if names.is_empty() { "none is installed".to_string() } else { format!("installed: {}", names.join(", ")) });
        }
        many => bail!("more than one plugin matches {wanted}: {}; delete the folder you do not want", many.iter().map(|i| pth(&i.folder)).collect::<Vec<_>>().join(", ")),
    };
    // The server keys the state by the manifest name (the folder name when the manifest is rejected).
    let name = target.name();
    let off = disabled(&ctx.config_dir);
    let folder = target.folder_name();
    if enable && folder != name && off.contains(&folder) {
        set_enabled(&ctx.config_dir, &folder, true).context("update plugins.json")?;
    }

    println!();
    if off.contains(&name) != enable {
        emit(&[verdict(Tone::Good, "✓", &format!("{} is already {}", exact(&name), if enable { "enabled" } else { "disabled" }))]);
        println!();
        return Ok(ExitCode::SUCCESS);
    }
    set_enabled(&ctx.config_dir, &name, enable).context("update plugins.json")?;
    emit(&[verdict(Tone::Good, "✓", &format!("{} {}", if enable { "Enabled" } else { "Disabled" }, exact(&name)))]);
    emit(&reload_server(&name, if enable { Change::Enabled } else { Change::Disabled }).0);
    println!();
    Ok(ExitCode::SUCCESS)
}
