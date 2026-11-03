//! `agentd plugin remove`: remove an installed plugin and keep its data
//! folder.

use super::prompt::{ask, Consent};
use super::reload::reload_server;
use super::render::{blank, emit, exact, ind, inline, pad, sp, verdict, Line, Tone};
use super::source::pth;
use super::{installed, Ctx, Installed};
use crate::cli::PluginRemoveArgs;
use anyhow::{bail, Context, Result};
use appv3_plugins::{data_dir_name, disabled, set_enabled};
use std::path::Path;
use std::process::ExitCode;

impl Installed {
    /// The manifest name, or the folder name when the manifest is rejected.
    fn name(&self) -> String {
        self.bundle.as_ref().map(|b| b.name.clone()).unwrap_or_else(|_| self.folder_name())
    }

    fn matches(&self, name: &str) -> bool {
        self.folder_name() == name || self.bundle.as_ref().is_ok_and(|b| b.name == name)
    }
}

/// Removes the folder, or only the link when it is a link.
fn delete_entry(path: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        // A link to a folder is a folder entry on Windows.
        std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path))
    } else {
        std::fs::remove_dir_all(path)
    }
}

pub(super) fn remove(args: &PluginRemoveArgs) -> Result<ExitCode> {
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
                bail!("{wanted} is a single-file plugin ({}); delete the file and restart the server to remove it", pth(&file));
            }
            let names: Vec<String> = items.iter().map(|i| exact(&i.name())).collect();
            bail!("no plugin named {wanted}; {}", if names.is_empty() { "none is installed".to_string() } else { format!("installed: {}", names.join(", ")) });
        }
        many => bail!("more than one plugin matches {wanted}: {}; delete the folder you do not want", many.iter().map(|i| pth(&i.folder)).collect::<Vec<_>>().join(", ")),
    };
    let name = target.name();
    let version = target.bundle.as_ref().ok().and_then(|b| b.version.clone()).map(|v| inline(&v, 40)).unwrap_or_default();
    let is_link = std::fs::symlink_metadata(&target.folder).is_ok_and(|m| m.file_type().is_symlink());
    let data = ctx.data_root.join(data_dir_name(&name));
    let mut out = vec![blank(), vec![ind(2), sp(Tone::Plain, "Remove "), sp(Tone::Bold, exact(&name)), ind(2), sp(Tone::Dim, version)]];
    out.push(item_line("Folder", &target.folder.to_string_lossy()));
    if is_link {
        out.push(vec![ind(4), sp(Tone::Dim, "It is a link: only the link is removed, not the folder it points to.")]);
    }
    if data.exists() {
        out.push(item_line("Data folder", &format!("{} (kept)", data.to_string_lossy())));
    }
    emit(&out);

    match ask(args.yes, &format!("Remove {}?", exact(&name)))? {
        Consent::Yes => {}
        Consent::No => {
            println!("\n  Cancelled; nothing was removed.\n");
            return Ok(ExitCode::FAILURE);
        }
        Consent::NeedsFlag => {
            println!("\n  Re-run with --yes to remove.\n");
            return Ok(ExitCode::from(2));
        }
    }

    delete_entry(&target.folder).with_context(|| format!("remove {}", pth(&target.folder)))?;
    println!();
    emit(&[verdict(Tone::Good, "✓", &format!("Removed {}", exact(&name)))]);
    // Drop it from the disabled list, so a plugin of the same name installed later starts enabled.
    let off = disabled(&ctx.config_dir);
    for listed in [name.clone(), target.folder_name()] {
        if off.contains(&listed) {
            set_enabled(&ctx.config_dir, &listed, true).context("update plugins.json")?;
        }
    }
    if data.exists() {
        emit(&[vec![ind(2), sp(Tone::Dim, format!("Data folder kept: {}", pth(&data)))]]);
    }
    emit(&reload_server(&name, true).0);
    println!();
    Ok(ExitCode::SUCCESS)
}

/// `    Label  value` under a heading.
fn item_line(label: &str, value: &str) -> Line {
    vec![ind(4), sp(Tone::Dim, pad(label, 13)), sp(Tone::Plain, exact(value))]
}
