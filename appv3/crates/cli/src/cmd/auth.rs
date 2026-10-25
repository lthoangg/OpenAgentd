//! `agentd auth <provider>`, `auth list`, `auth logout <provider>`, and
//! `agentd credentials list|import`.

use crate::cli::{AuthArgs, AuthCmd, CredentialsCmd};
use crate::ui::{bold, dim, green, tilde};
use anyhow::{anyhow, Result};
use appv3_core::credentials as store;
use appv3_providers::oauth::{TokenSlot, PROVIDERS};
use std::process::ExitCode;

/// Move legacy `.env` keys and OAuth files into `credentials.yaml` before
/// anything writes it (the migration only runs while the file is absent).
pub fn migrate_first() {
    if let Some(r) = appv3_providers::credentials_migration::migrate_active() {
        let mut moved: Vec<String> = r.providers.iter().map(|(p, _)| p.clone()).collect();
        moved.extend(r.oauth.iter().map(|p| format!("{p} (OAuth)")));
        if !r.secrets.is_empty() {
            moved.push(format!("{} named secret(s)", r.secrets.len()));
        }
        println!("  {}  Moved saved credentials into {}: {}", green("✓"), tilde(&store::path()), moved.join(", "));
    }
}

pub fn auth(args: &AuthArgs) -> Result<ExitCode> {
    migrate_first();
    store::load().map_err(|e| anyhow!("{e}"))?;
    match (&args.action, &args.provider) {
        (Some(AuthCmd::Logout { provider, account }), _) => logout(provider, account.as_deref()).map(|_| ExitCode::SUCCESS),
        (None, Some(provider)) if !args.list => login(provider, args),
        _ => {
            list();
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// The stored credential named by a label (case-insensitive) or id.
fn find_account(provider: &str, account: &str) -> Result<store::Credential> {
    let f = store::snapshot();
    let list = f.provider(provider);
    list.iter()
        .find(|c| c.id == account)
        .or_else(|| list.iter().find(|c| c.label.eq_ignore_ascii_case(account)))
        .cloned()
        .ok_or_else(|| anyhow!("no {provider} account named {account:?} (see `agentd auth list`)"))
}

fn list() {
    let mut providers = PROVIDERS.to_vec();
    providers.sort();
    let f = store::snapshot();
    println!();
    println!("  {}", bold("OAuth providers"));
    println!();
    for (id, desc) in providers {
        let accounts = f.provider(id);
        let connected = accounts.iter().filter(|c| c.has_secret()).count();
        let state = if connected > 0 { green(&format!("{connected} logged in  ")) } else { dim("not logged in") };
        println!("  {}  {state}  {}", bold(&format!("{id:<8}")), dim(desc));
        for (i, c) in accounts.iter().enumerate() {
            let note = if c.disabled {
                " (disabled)"
            } else if !c.has_secret() {
                " (reconnect required)"
            } else {
                ""
            };
            println!("      {}. {}{}", i + 1, c.label, dim(note));
        }
    }
    println!();
    println!("  {}  agentd auth <provider> [--add | --account <name>]", dim("Log in: "));
    println!("  {}  agentd auth logout <provider> [--account <name>]", dim("Log out:"));
    println!();
}

fn login(provider: &str, args: &AuthArgs) -> Result<ExitCode> {
    let slot = match (&args.account, args.add) {
        (Some(a), _) => TokenSlot::new(provider, &find_account(provider, a)?.id),
        (None, true) => TokenSlot::new_account(provider),
        (None, false) => TokenSlot::active(provider),
    };
    let device = args.device;
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let res = rt.block_on(async move {
        match provider {
            "copilot" => appv3_providers::copilot::login(None, None, slot).await,
            "codex" => appv3_providers::codex::login(None, device, false, slot).await,
            _ => appv3_providers::grok::login(None, slot).await,
        }
    });
    match res {
        Ok(()) => Ok(ExitCode::SUCCESS),
        // The flow already printed why it failed.
        Err(_) if appv3_providers::codex::cli_failure_reported() => Ok(ExitCode::FAILURE),
        Err(e) => Err(anyhow!("{provider} login failed: {e}")),
    }
}

fn logout(provider: &str, account: Option<&str>) -> Result<()> {
    let target = account.map(|a| find_account(provider, a)).transpose()?;
    let pid = provider.to_string();
    let removed = store::update(|f| match &target {
        Some(c) => usize::from(f.remove(&pid, &c.id).is_some()),
        None => f.providers.shift_remove(&pid).map(|l| l.len()).unwrap_or(0),
    })
    .map_err(|e| anyhow!("{e}"))?;
    if !store::snapshot().enabled(provider).iter().any(|c| c.has_secret()) {
        let _ = appv3_core::runtime_settings::forget_provider_models(provider);
    }
    match (removed, &target) {
        (0, _) => println!("  {provider} was not logged in"),
        (_, Some(c)) => println!("  {}  Logged out of {provider} ({})", green("✓"), c.label),
        (n, None) => println!("  {}  Logged out of {provider} ({n} account{})", green("✓"), if n == 1 { "" } else { "s" }),
    }
    Ok(())
}

pub fn credentials(cmd: &CredentialsCmd) -> Result<ExitCode> {
    migrate_first();
    match cmd {
        CredentialsCmd::List => {
            let f = store::load().map_err(|e| anyhow!("{e}"))?;
            println!();
            println!("  {}  {}", bold("Credentials"), dim(&tilde(&store::path())));
            println!();
            if f.providers.is_empty() && f.secrets.is_empty() {
                println!("  {}", dim("None stored. Add keys in Settings → Providers or run `agentd credentials import <file>`."));
            }
            for (pid, list) in &f.providers {
                println!("  {}", bold(pid));
                for (i, c) in list.iter().enumerate() {
                    let what = if c.oauth.is_some() { "OAuth".to_string() } else { c.values.keys().cloned().collect::<Vec<_>>().join(", ") };
                    let off = if c.disabled { " (disabled)" } else { "" };
                    println!("    {}. {}{}  {}", i + 1, c.label, dim(off), dim(&what));
                }
            }
            if !f.secrets.is_empty() {
                println!("  {}  {}", bold("secrets"), dim(&f.secrets.keys().cloned().collect::<Vec<_>>().join(", ")));
            }
            println!();
            Ok(ExitCode::SUCCESS)
        }
        CredentialsCmd::Import { path, label } => {
            let r = appv3_providers::credentials_migration::import_dotenv(path, label).map_err(|e| anyhow!("{e}"))?;
            for (p, names) in &r.providers {
                println!("  {}  {p}: {}", green("✓"), names.join(", "));
            }
            if !r.secrets.is_empty() {
                println!("  {}  secrets: {}", green("✓"), r.secrets.join(", "));
            }
            if !r.unchanged.is_empty() {
                println!("  {}", dim(&format!("Already stored: {}", r.unchanged.join(", "))));
            }
            if r.is_empty() && r.unchanged.is_empty() {
                println!("  No provider keys found in {}", path.display());
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}
