//! `agentd auth <provider>`, `auth list`, `auth logout <provider>`.

use crate::cli::{AuthArgs, AuthCmd};
use crate::ui::{bold, dim, green};
use anyhow::{anyhow, Context, Result};
use appv3_providers::oauth::{oauth_path, PROVIDERS};
use std::process::ExitCode;

pub fn auth(args: &AuthArgs) -> Result<ExitCode> {
    match (&args.action, &args.provider) {
        (Some(AuthCmd::Logout { provider }), _) => logout(provider).map(|_| ExitCode::SUCCESS),
        (None, Some(provider)) if !args.list => login(provider, args.device),
        _ => {
            list();
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn logged_in(provider: &str) -> bool {
    oauth_path(provider).is_some_and(|p| p.is_file())
}

fn list() {
    let mut providers = PROVIDERS.to_vec();
    providers.sort();
    println!();
    println!("  {}", bold("OAuth providers"));
    println!();
    for (id, desc) in providers {
        let state = if logged_in(id) { green("logged in    ") } else { dim("not logged in") };
        println!("  {}  {state}  {}", bold(&format!("{id:<8}")), dim(desc));
    }
    println!();
    println!("  {}  agentd auth <provider>", dim("Log in: "));
    println!("  {}  agentd auth logout <provider>", dim("Log out:"));
    println!();
}

fn login(provider: &str, device: bool) -> Result<ExitCode> {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let res = rt.block_on(async move {
        match provider {
            "copilot" => appv3_providers::copilot::login(None, None).await,
            "codex" => appv3_providers::codex::login(None, device, false).await,
            _ => appv3_providers::grok::login(None).await,
        }
    });
    match res {
        Ok(()) => Ok(ExitCode::SUCCESS),
        // The flow already printed why it failed.
        Err(_) if appv3_providers::codex::cli_failure_reported() => Ok(ExitCode::FAILURE),
        Err(e) => Err(anyhow!("{provider} login failed: {e}")),
    }
}

fn logout(provider: &str) -> Result<()> {
    let path = oauth_path(provider).ok_or_else(|| anyhow!("unknown OAuth provider {provider:?}"))?;
    let removed = path.is_file();
    if removed {
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    }
    let _ = appv3_core::runtime_settings::forget_provider_models(provider);
    if removed {
        println!("  {}  Logged out of {provider}", green("✓"));
    } else {
        println!("  {provider} was not logged in");
    }
    Ok(())
}
